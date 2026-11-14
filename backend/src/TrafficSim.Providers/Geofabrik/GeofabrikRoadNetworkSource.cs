using Microsoft.Extensions.Options;
using TrafficSim.Application.Providers;
using TrafficSim.Domain.Geo;
using TrafficSim.Domain.Osm;
using TrafficSim.Providers.Http;

namespace TrafficSim.Providers.Geofabrik;

/// <summary>
/// Road network source for large areas: downloads the smallest Geofabrik regional extract covering the
/// area into the bind-mounted OSM directory (re-used until older than MaxAge) and reads roads from it.
/// </summary>
public sealed class GeofabrikRoadNetworkSource : IRoadNetworkSource
{
    public const string ProviderName = "geofabrik";
    public const string AttributionText = "Data © OpenStreetMap contributors (ODbL) via Geofabrik extracts";
    private const string IndexFile = "index-v1.json";

    private readonly HttpClient _httpClient;
    private readonly GeofabrikOptions _options;
    private readonly TimeProvider _time;
    private readonly SemaphoreSlim _downloadLock = new(1, 1);

    public GeofabrikRoadNetworkSource(HttpClient httpClient, IOptions<ProvidersOptions> options, TimeProvider time)
    {
        ArgumentNullException.ThrowIfNull(options);
        _httpClient = httpClient;
        _options = options.Value.Geofabrik;
        _time = time;
    }

    public string Name => ProviderName;

    public int Priority => _options.Priority;

    public string Attribution => AttributionText;

    public double MaxAreaSquareKilometers => _options.MaxAreaSquareKilometers;

    private string Directory => _options.Directory ?? throw new InvalidOperationException("Geofabrik directory not configured.");

    public async Task<OsmDataSet> FetchAsync(BoundingBox area, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(area);
        var indexPath = await EnsureFileAsync(IndexFile, new Uri(IndexFile, UriKind.Relative), cancellationToken).ConfigureAwait(false);
        IReadOnlyList<GeofabrikRegion> regions;
        await using (var index = File.OpenRead(indexPath))
        {
            regions = await ProviderErrors.GuardAsync(ProviderName, () => Task.FromResult(GeofabrikIndex.Parse(index)), cancellationToken).ConfigureAwait(false);
        }

        var region = GeofabrikIndex.Select(regions, area)
            ?? throw new ProviderUnavailableException(ProviderName, "no regional extract covers the area");
        var pbfPath = await EnsureFileAsync(FileNameFor(region), region.PbfUrl, cancellationToken).ConfigureAwait(false);

        return await Task.Run(() =>
        {
            using var stream = File.OpenRead(pbfPath);
            return PbfRoadReader.Read(stream, area, _options.MarginMetres, cancellationToken);
        }, cancellationToken).ConfigureAwait(false);
    }

    internal static string FileNameFor(GeofabrikRegion region) =>
        new string(region.Id.Select(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_' ? c : '_').ToArray()) + ".osm.pbf";

    private async Task<string> EnsureFileAsync(string fileName, Uri source, CancellationToken cancellationToken)
    {
        var path = Path.Combine(Directory, fileName);
        await _downloadLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (File.Exists(path) && _time.GetUtcNow() - File.GetLastWriteTimeUtc(path) < _options.MaxAge)
            {
                return path;
            }

            System.IO.Directory.CreateDirectory(Directory);
            var temp = path + ".download";
            await ProviderErrors.GuardAsync(ProviderName, async () =>
            {
                using var response = await _httpClient.GetAsync(source, HttpCompletionOption.ResponseHeadersRead, cancellationToken).ConfigureAwait(false);
                ProviderErrors.EnsureSuccess(ProviderName, response);
                await using var body = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
                await using var file = File.Create(temp);
                await body.CopyToAsync(file, cancellationToken).ConfigureAwait(false);
                return true;
            }, cancellationToken).ConfigureAwait(false);
            File.Move(temp, path, overwrite: true);
            return path;
        }
        finally
        {
            _downloadLock.Release();
        }
    }
}
