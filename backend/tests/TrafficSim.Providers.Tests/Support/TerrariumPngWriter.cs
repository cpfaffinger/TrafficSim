using System.Buffers.Binary;
using System.IO.Compression;

namespace TrafficSim.Providers.Tests.Support;

/// <summary>
/// Encodes heights as Terrarium PNG tiles for decoder tests. Rows cycle through all five PNG filter
/// types so every unfilter path is exercised.
/// </summary>
internal static class TerrariumPngWriter
{
    public static byte[] Encode(int width, int height, Func<int, int, double> metres, bool alpha = false)
    {
        var channels = alpha ? 4 : 3;
        var stride = width * channels;
        var pixels = new byte[height * stride];
        for (var y = 0; y < height; y++)
        {
            for (var x = 0; x < width; x++)
            {
                var v = metres(x, y) + 32768;
                var whole = (int)Math.Floor(v);
                var p = (y * stride) + (x * channels);
                pixels[p] = (byte)(whole / 256);
                pixels[p + 1] = (byte)(whole % 256);
                pixels[p + 2] = (byte)Math.Round((v - whole) * 256);
                if (alpha)
                {
                    pixels[p + 3] = 255;
                }
            }
        }

        var filtered = new byte[height * (stride + 1)];
        for (var y = 0; y < height; y++)
        {
            var filter = (byte)(y % 5);
            filtered[y * (stride + 1)] = filter;
            for (var i = 0; i < stride; i++)
            {
                int raw = pixels[(y * stride) + i];
                int a = i >= channels ? pixels[(y * stride) + i - channels] : 0;
                int b = y > 0 ? pixels[((y - 1) * stride) + i] : 0;
                int c = i >= channels && y > 0 ? pixels[((y - 1) * stride) + i - channels] : 0;
                var predictor = filter switch
                {
                    0 => 0,
                    1 => a,
                    2 => b,
                    3 => (a + b) >> 1,
                    _ => Paeth(a, b, c),
                };
                filtered[(y * (stride + 1)) + 1 + i] = (byte)(raw - predictor);
            }
        }

        using var compressed = new MemoryStream();
        using (var zlib = new ZLibStream(compressed, CompressionLevel.Optimal, leaveOpen: true))
        {
            zlib.Write(filtered);
        }

        using var png = new MemoryStream();
        png.Write([137, 80, 78, 71, 13, 10, 26, 10]);
        var header = new byte[13];
        BinaryPrimitives.WriteInt32BigEndian(header, width);
        BinaryPrimitives.WriteInt32BigEndian(header.AsSpan(4), height);
        header[8] = 8;
        header[9] = (byte)(alpha ? 6 : 2);
        Chunk(png, "IHDR", header);
        var data = compressed.ToArray();
        // Split the image data over two IDAT chunks like real encoders do.
        Chunk(png, "IDAT", data[..(data.Length / 2)]);
        Chunk(png, "IDAT", data[(data.Length / 2)..]);
        Chunk(png, "IEND", []);
        return png.ToArray();
    }

    private static int Paeth(int a, int b, int c)
    {
        var p = a + b - c;
        var pa = Math.Abs(p - a);
        var pb = Math.Abs(p - b);
        var pc = Math.Abs(p - c);
        return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    }

    private static void Chunk(Stream png, string type, byte[] data)
    {
        Span<byte> buffer = stackalloc byte[4];
        BinaryPrimitives.WriteInt32BigEndian(buffer, data.Length);
        png.Write(buffer);
        var typeBytes = System.Text.Encoding.ASCII.GetBytes(type);
        png.Write(typeBytes);
        png.Write(data);
        BinaryPrimitives.WriteUInt32BigEndian(buffer, Crc32([.. typeBytes, .. data]));
        png.Write(buffer);
    }

    private static uint Crc32(byte[] bytes)
    {
        var crc = 0xFFFFFFFFu;
        foreach (var b in bytes)
        {
            crc ^= b;
            for (var k = 0; k < 8; k++)
            {
                crc = (crc & 1) != 0 ? 0xEDB88320u ^ (crc >> 1) : crc >> 1;
            }
        }

        return ~crc;
    }
}
