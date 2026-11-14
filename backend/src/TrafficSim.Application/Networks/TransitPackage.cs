using TrafficSim.Domain.Network;

namespace TrafficSim.Application.Networks;

// Optional transit part of the network package v1 (#85, docs/architecture/network-package.md).

public sealed record PackageTransitStop(string Id, long? OsmId, string? Name, string Link, double Pos, bool Bay);

public sealed record PackageTransitLine(
    string Id,
    long? OsmId,
    string? Ref,
    string? Name,
    string Mode,
    string? Colour,
    double? Headway,
    IReadOnlyList<string> Links,
    IReadOnlyList<PackageTransitStop> Stops);

/// <summary>Maps the transit lines of a compiled network to the package (absent when there are none).</summary>
public static class TransitPackage
{
    public static IReadOnlyList<PackageTransitLine>? Lines(RoadNetwork network)
    {
        ArgumentNullException.ThrowIfNull(network);
        return network.TransitLines.Count == 0
            ? null
            : network.TransitLines.Select(l => new PackageTransitLine(
                l.Id,
                l.OsmId,
                l.Ref,
                l.Name,
                l.Mode,
                l.Colour,
                l.Headway,
                l.Links.ToList(),
                l.Stops.Select(s => new PackageTransitStop(s.Id, s.OsmId, s.Name, s.LinkId, Math.Round(s.Position, 2), s.Bay)).ToList())).ToList();
    }
}
