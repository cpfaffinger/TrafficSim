using Microsoft.AspNetCore.Http.HttpResults;
using TrafficSim.Application.Geocoding;
using TrafficSim.Domain.Geo;

namespace TrafficSim.Api.Endpoints;

public sealed record GeocodeResultDto(
    string Label,
    double Latitude,
    double Longitude,
    string Category,
    double[]? Bbox,
    string? OsmReference);

public sealed record GeocodeResponseDto(IReadOnlyList<GeocodeResultDto> Results, string Provider, string Attribution);

internal static class GeocodingEndpoints
{
    public static RouteGroupBuilder MapGeocodingEndpoints(this RouteGroupBuilder group)
    {
        group.MapGet("/geocode", SearchAsync).WithName("Geocode");
        return group;
    }

    internal static async Task<Results<Ok<GeocodeResponseDto>, ProblemHttpResult>> SearchAsync(
        string? q,
        int? limit,
        string? lang,
        double? lat,
        double? lon,
        GeocodingService service,
        CancellationToken cancellationToken)
    {
        GeocodeQuery query;
        try
        {
            GeoPoint? bias = lat is { } la && lon is { } lo ? new GeoPoint(la, lo) : null;
            query = new GeocodeQuery(q ?? string.Empty, limit ?? 5, lang, bias);
        }
        catch (ArgumentException ex)
        {
            return TypedResults.Problem(statusCode: StatusCodes.Status400BadRequest, title: "Invalid geocoding query", detail: ex.Message);
        }

        try
        {
            var response = await service.SearchAsync(query, cancellationToken).ConfigureAwait(false);
            var dtos = response.Results.Select(r => new GeocodeResultDto(
                r.Label,
                r.Location.Latitude,
                r.Location.Longitude,
                r.Category,
                r.Extent is { } e ? [e.West, e.South, e.East, e.North] : null,
                r.OsmReference)).ToList();
            return TypedResults.Ok(new GeocodeResponseDto(dtos, response.Provider, response.Attribution));
        }
        catch (NoProviderAvailableException ex)
        {
            return TypedResults.Problem(statusCode: StatusCodes.Status503ServiceUnavailable, title: "Geocoding unavailable", detail: ex.Message);
        }
    }
}
