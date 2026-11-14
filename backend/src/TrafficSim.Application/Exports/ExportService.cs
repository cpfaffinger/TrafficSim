using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using TrafficSim.Application.Networks;
using TrafficSim.Application.Scenarios;
using TrafficSim.Domain.Geo;

namespace TrafficSim.Application.Exports;

/// <summary>
/// Exports (#75): network and per-link run metrics as GeoJSON (WGS84) and CSV. Every export carries the
/// ODbL attribution because it is a derived database of OpenStreetMap data (ADR-0014).
/// </summary>
/// <remarks>
/// Run summaries are uploaded by the browser; per-link metrics are read from an optional
/// <c>links</c> array of objects with an <c>id</c> (link id) and numeric metric fields.
/// </remarks>
public sealed class ExportService(ScenarioService scenarios)
{
    public const string License = "Contains information from OpenStreetMap, made available under the Open Database License (ODbL) 1.0 — https://opendatacommons.org/licenses/odbl/";

    public async Task<string> NetworkGeoJsonAsync(Guid scenarioId, CancellationToken cancellationToken)
    {
        var package = await PackageAsync(scenarioId, cancellationToken).ConfigureAwait(false);
        return GeoJson(package, metrics: null);
    }

    public async Task<string> RunLinksGeoJsonAsync(Guid runId, CancellationToken cancellationToken)
    {
        var run = await scenarios.GetRunAsync(runId, cancellationToken).ConfigureAwait(false);
        var package = await PackageAsync(run.ScenarioId, cancellationToken).ConfigureAwait(false);
        return GeoJson(package, LinkMetrics(run.SummaryJson));
    }

    public async Task<string> RunLinksCsvAsync(Guid runId, CancellationToken cancellationToken)
    {
        var run = await scenarios.GetRunAsync(runId, cancellationToken).ConfigureAwait(false);
        var package = await PackageAsync(run.ScenarioId, cancellationToken).ConfigureAwait(false);
        var metrics = LinkMetrics(run.SummaryJson);
        var keys = metrics.Values.SelectMany(m => m.Keys).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToList();
        var csv = new StringBuilder();
        csv.Append("# ").AppendLine(License);
        csv.AppendLine(string.Join(',', new[] { "link_id", "osm_way_id", "road_class", "name", "lanes", "speed_limit_kmh", "length_m" }.Concat(keys)));
        foreach (var link in package.Links)
        {
            var values = new List<string>
            {
                link.Id,
                link.OsmWayId?.ToString(CultureInfo.InvariantCulture) ?? string.Empty,
                link.RoadClass,
                Escape(link.Name),
                link.Lanes.Count.ToString(CultureInfo.InvariantCulture),
                (link.SpeedLimit * 3.6).ToString("F0", CultureInfo.InvariantCulture),
                link.Length.ToString("F1", CultureInfo.InvariantCulture),
            };
            var m = metrics.GetValueOrDefault(link.Id);
            values.AddRange(keys.Select(k => m is not null && m.TryGetValue(k, out var v) ? v.ToString("R", CultureInfo.InvariantCulture) : string.Empty));
            csv.AppendLine(string.Join(',', values));
        }

        return csv.ToString();
    }

    /// <summary>Flattens the run's KPI summary (scalar fields, nested objects with dotted keys) into CSV.</summary>
    public async Task<string> RunSummaryCsvAsync(Guid runId, CancellationToken cancellationToken)
    {
        var run = await scenarios.GetRunAsync(runId, cancellationToken).ConfigureAwait(false);
        var csv = new StringBuilder();
        csv.Append("# ").AppendLine(License);
        csv.AppendLine("metric,value");
        csv.Append("run_id,").AppendLine(run.Id.ToString());
        csv.Append("seed,").AppendLine(run.Seed.ToString(CultureInfo.InvariantCulture));
        csv.Append("simulated_seconds,").AppendLine(run.SimulatedSeconds.ToString("R", CultureInfo.InvariantCulture));
        using var doc = JsonDocument.Parse(run.SummaryJson);
        Flatten(doc.RootElement, string.Empty, csv);
        return csv.ToString();
    }

    private async Task<NetworkPackage> PackageAsync(Guid scenarioId, CancellationToken cancellationToken)
    {
        var scenario = await scenarios.GetAsync(scenarioId, cancellationToken).ConfigureAwait(false);
        var compiled = await scenarios.CompileAsync(scenario.BaselineId, scenario.Changeset, cancellationToken).ConfigureAwait(false);
        return NetworkPackageWriter.DeserializeGzip(compiled.GzipPackage);
    }

    internal static string GeoJson(NetworkPackage package, IReadOnlyDictionary<string, Dictionary<string, double>>? metrics)
    {
        var plane = new LocalTangentPlane(new GeoPoint(package.Origin.Lat, package.Origin.Lon));
        var features = new JsonArray();
        foreach (var link in package.Links)
        {
            var coordinates = new JsonArray(link.Geometry.Select(p =>
            {
                var g = plane.ToGeo(new LocalPoint(p[0], p[1]));
                return (JsonNode)new JsonArray(Math.Round(g.Longitude, 7), Math.Round(g.Latitude, 7));
            }).ToArray());
            var properties = new JsonObject
            {
                ["id"] = link.Id,
                ["osmWayId"] = link.OsmWayId,
                ["roadClass"] = link.RoadClass,
                ["name"] = link.Name,
                ["lanes"] = link.Lanes.Count,
                ["speedLimitKmh"] = Math.Round(link.SpeedLimit * 3.6),
                ["layer"] = link.Layer,
                ["structure"] = link.Structure,
                ["lengthM"] = link.Length,
            };
            if (metrics?.GetValueOrDefault(link.Id) is { } m)
            {
                foreach (var (k, v) in m)
                {
                    properties[k] = v;
                }
            }

            features.Add(new JsonObject
            {
                ["type"] = "Feature",
                ["geometry"] = new JsonObject { ["type"] = "LineString", ["coordinates"] = coordinates },
                ["properties"] = properties,
            });
        }

        var collection = new JsonObject
        {
            ["type"] = "FeatureCollection",
            ["license"] = License,
            ["attribution"] = new JsonArray(package.Attribution.Select(a => (JsonNode)JsonValue.Create(a)!).ToArray()),
            ["features"] = features,
        };
        return collection.ToJsonString();
    }

    internal static Dictionary<string, Dictionary<string, double>> LinkMetrics(string summaryJson)
    {
        var result = new Dictionary<string, Dictionary<string, double>>(StringComparer.Ordinal);
        using var doc = JsonDocument.Parse(summaryJson);
        if (doc.RootElement.ValueKind != JsonValueKind.Object || !doc.RootElement.TryGetProperty("links", out var links) || links.ValueKind != JsonValueKind.Array)
        {
            return result;
        }

        foreach (var item in links.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object || !item.TryGetProperty("id", out var id) || id.ValueKind != JsonValueKind.String)
            {
                continue;
            }

            var values = new Dictionary<string, double>(StringComparer.Ordinal);
            foreach (var p in item.EnumerateObject().Where(p => p.Value.ValueKind == JsonValueKind.Number))
            {
                values[p.Name] = p.Value.GetDouble();
            }

            result[id.GetString()!] = values;
        }

        return result;
    }

    private static void Flatten(JsonElement element, string prefix, StringBuilder csv)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                foreach (var p in element.EnumerateObject())
                {
                    Flatten(p.Value, prefix.Length == 0 ? p.Name : $"{prefix}.{p.Name}", csv);
                }

                break;
            case JsonValueKind.Number or JsonValueKind.String or JsonValueKind.True or JsonValueKind.False:
                csv.Append(Escape(prefix)).Append(',').AppendLine(Escape(element.ToString()));
                break;
        }
    }

    private static string Escape(string? value) =>
        value is null ? string.Empty : value.IndexOfAny([',', '"', '\n', '\r']) >= 0 ? $"\"{value.Replace("\"", "\"\"", StringComparison.Ordinal)}\"" : value;
}
