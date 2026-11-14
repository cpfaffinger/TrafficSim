using Microsoft.Extensions.Logging;
using TrafficSim.Application.Providers;
using TrafficSim.Domain.Geo;
using TrafficSim.Domain.Osm;

namespace TrafficSim.Application.RoadNetwork;

/// <summary>Raised when no road network source accepts an area of the requested size.</summary>
public sealed class AreaTooLargeException : Exception
{
    public AreaTooLargeException()
    {
    }

    public AreaTooLargeException(string message)
        : base(message)
    {
    }

    public AreaTooLargeException(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}

/// <summary>
/// Fetches raw OSM road data for an area from the best available source: sources whose size limit
/// admits the area are tried by priority (Overpass for small areas, Geofabrik extracts for large ones).
/// </summary>
public sealed partial class RoadNetworkService(IEnumerable<IRoadNetworkSource> sources, ILogger<RoadNetworkService> logger)
{
    private readonly IReadOnlyList<IRoadNetworkSource> _sources = ProviderFallback.Order(sources);
    private readonly ILogger<RoadNetworkService> _logger = logger;

    public double MaxAreaSquareKilometers => _sources.Count == 0 ? 0 : _sources.Max(s => s.MaxAreaSquareKilometers);

    public async Task<ProviderAnswer<OsmDataSet>> FetchAsync(BoundingBox area, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(area);
        var size = area.AreaSquareKilometers;
        var eligible = _sources.Where(s => s.MaxAreaSquareKilometers >= size).ToList();
        if (_sources.Count > 0 && eligible.Count == 0)
        {
            throw new AreaTooLargeException(
                string.Create(System.Globalization.CultureInfo.InvariantCulture,
                    $"Area of {size:F1} km² exceeds the largest supported area of {MaxAreaSquareKilometers:F1} km²."));
        }

        return await ProviderFallback.FirstAvailableAsync(
            eligible,
            "road network",
            s => s.FetchAsync(area, cancellationToken),
            (s, ex) => LogSourceFailed(s.Name, ex.Message)).ConfigureAwait(false);
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "Road network source {Source} failed, trying next: {Reason}")]
    private partial void LogSourceFailed(string source, string reason);
}
