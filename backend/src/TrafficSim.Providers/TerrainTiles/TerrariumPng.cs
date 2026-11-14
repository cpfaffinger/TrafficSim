using System.Buffers.Binary;
using System.IO.Compression;

namespace TrafficSim.Providers.TerrainTiles;

/// <summary>A decoded Terrarium tile: heights in metres, row-major from the north-west pixel.</summary>
internal sealed record TerrariumTile(int Width, int Height, float[] Heights)
{
    public float At(int x, int y) => Heights[(y * Width) + x];
}

/// <summary>
/// Minimal PNG decoder for Terrarium elevation tiles (ADR-0018): 8-bit RGB or RGBA, not interlaced, all
/// five scanline filters. Height = <c>R·256 + G + B/256 − 32768</c> metres.
/// </summary>
internal static class TerrariumPng
{
    private static readonly byte[] Signature = [137, 80, 78, 71, 13, 10, 26, 10];
    private const int MaxSide = 4096;

    /// <exception cref="InvalidDataException">Not a supported PNG.</exception>
    public static TerrariumTile Decode(ReadOnlySpan<byte> png)
    {
        if (png.Length < Signature.Length || !png[..Signature.Length].SequenceEqual(Signature))
        {
            throw new InvalidDataException("not a PNG file");
        }

        int width = 0, height = 0, channels = 0;
        using var idat = new MemoryStream();
        var offset = Signature.Length;
        while (offset + 8 <= png.Length)
        {
            var length = BinaryPrimitives.ReadInt32BigEndian(png[offset..]);
            var type = png.Slice(offset + 4, 4);
            if (length < 0 || offset + 12 + (long)length > png.Length)
            {
                throw new InvalidDataException("truncated PNG chunk");
            }

            var data = png.Slice(offset + 8, length);
            if (type.SequenceEqual("IHDR"u8))
            {
                (width, height, channels) = Header(data);
            }
            else if (type.SequenceEqual("IDAT"u8))
            {
                idat.Write(data);
            }
            else if (type.SequenceEqual("IEND"u8))
            {
                break;
            }

            offset += 12 + length;
        }

        if (width == 0 || idat.Length == 0)
        {
            throw new InvalidDataException("PNG without header or image data");
        }

        var stride = width * channels;
        var raw = Inflate(idat, (stride + 1) * height);
        Unfilter(raw, stride, height, channels);
        var heights = new float[width * height];
        for (var y = 0; y < height; y++)
        {
            var row = (y * (stride + 1)) + 1;
            for (var x = 0; x < width; x++)
            {
                var p = row + (x * channels);
                heights[(y * width) + x] = (float)((raw[p] * 256.0) + raw[p + 1] + (raw[p + 2] / 256.0) - 32768.0);
            }
        }

        return new TerrariumTile(width, height, heights);
    }

    private static (int Width, int Height, int Channels) Header(ReadOnlySpan<byte> data)
    {
        if (data.Length < 13)
        {
            throw new InvalidDataException("short IHDR");
        }

        var width = BinaryPrimitives.ReadInt32BigEndian(data);
        var height = BinaryPrimitives.ReadInt32BigEndian(data[4..]);
        var (bitDepth, colorType, interlace) = (data[8], data[9], data[12]);
        if (width is <= 0 or > MaxSide || height is <= 0 or > MaxSide)
        {
            throw new InvalidDataException($"unsupported PNG size {width}×{height}");
        }

        if (bitDepth != 8 || colorType is not (2 or 6) || interlace != 0)
        {
            throw new InvalidDataException($"unsupported PNG format (bit depth {bitDepth}, colour type {colorType}, interlace {interlace})");
        }

        return (width, height, colorType == 2 ? 3 : 4);
    }

    private static byte[] Inflate(MemoryStream idat, int expected)
    {
        idat.Position = 0;
        using var zlib = new ZLibStream(idat, CompressionMode.Decompress);
        var raw = new byte[expected];
        var read = 0;
        while (read < expected)
        {
            var n = zlib.Read(raw, read, expected - read);
            if (n == 0)
            {
                throw new InvalidDataException("PNG image data is truncated");
            }

            read += n;
        }

        return raw;
    }

    /// <summary>Reverses the scanline filters in place (PNG spec §9).</summary>
    private static void Unfilter(byte[] raw, int stride, int height, int bpp)
    {
        for (var y = 0; y < height; y++)
        {
            var row = y * (stride + 1);
            var prev = row - stride - 1; // start of the previous row's pixels minus one
            var filter = raw[row];
            for (var i = 0; i < stride; i++)
            {
                var at = row + 1 + i;
                int a = i >= bpp ? raw[at - bpp] : 0;
                int b = y > 0 ? raw[prev + 1 + i] : 0;
                int c = i >= bpp && y > 0 ? raw[prev + 1 + i - bpp] : 0;
                raw[at] = filter switch
                {
                    0 => raw[at],
                    1 => (byte)(raw[at] + a),
                    2 => (byte)(raw[at] + b),
                    3 => (byte)(raw[at] + ((a + b) >> 1)),
                    4 => (byte)(raw[at] + Paeth(a, b, c)),
                    _ => throw new InvalidDataException($"unknown PNG filter {filter}"),
                };
            }
        }
    }

    private static int Paeth(int a, int b, int c)
    {
        var p = a + b - c;
        var pa = Math.Abs(p - a);
        var pb = Math.Abs(p - b);
        var pc = Math.Abs(p - c);
        return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    }
}
