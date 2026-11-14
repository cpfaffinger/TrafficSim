namespace TrafficSim.Providers.Overpass;

/// <summary>Overpass QL statements for public transport lines (#85, ADR-0019).</summary>
internal static partial class OverpassQuery
{
    /// <summary>Route types simulated as buses.</summary>
    public const string TransitRoutePattern = "^(bus|trolleybus)$";

    /// <summary>
    /// Appended after the road output (the default set then holds the roads and their nodes): bus and
    /// trolleybus route relations using any of the roads, their member nodes inside the area (stop
    /// positions and platforms) and their route masters. Relations are printed with their member
    /// references only; ways outside the area are not fetched.
    /// </summary>
    public static string TransitStatements(string areaFilter) =>
        $"rel(bw)[\"type\"=\"route\"][\"route\"~\"{TransitRoutePattern}\"]->.lines;" +
        $"node(r.lines)({areaFilter});out body qt;" +
        ".lines out body qt;" +
        "rel(br.lines)[\"type\"=\"route_master\"];out body qt;";
}
