namespace TrafficSim.Domain.Network;

/// <summary>A stop of a transit line: where on which link of the line's route the bus halts (#85).</summary>
/// <param name="Id">Unique within the network.</param>
/// <param name="OsmId">Stop position node, or the platform node when the stop position is not mapped.</param>
/// <param name="LinkId">Link of the line's route the stop lies on.</param>
/// <param name="Position">Distance along the link's geometry (m) where the bus front halts.</param>
/// <param name="Bay">The bus pulls into a bay and does not block the kerb lane while dwelling.</param>
public sealed record TransitStop(string Id, long? OsmId, string? Name, string LinkId, double Position, bool Bay);

/// <summary>
/// One direction of a public transport line (an OSM PTv2 route relation, ADR-0019) mapped onto the lane
/// graph: a connected sequence of links from where it enters (or starts in) the network to where it
/// leaves (or ends), with its stops in driving order.
/// </summary>
public sealed class TransitLine
{
    public required string Id { get; init; }

    public long? OsmId { get; init; }

    /// <summary>Line number (<c>ref</c>), e.g. <c>"59A"</c>.</summary>
    public string? Ref { get; init; }

    public string? Name { get; init; }

    /// <summary><c>bus</c> or <c>trolleybus</c>.</summary>
    public required string Mode { get; init; }

    /// <summary>Line colour from OSM (<c>colour</c>), e.g. <c>"#e2001a"</c>.</summary>
    public string? Colour { get; init; }

    /// <summary>Headway (s) from the OSM <c>interval</c> tag of the route or its route master; null when not mapped.</summary>
    public double? Headway { get; init; }

    public required IReadOnlyList<string> Links { get; init; }

    public required IReadOnlyList<TransitStop> Stops { get; init; }
}
