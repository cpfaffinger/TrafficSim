namespace TrafficSim.Api.Http;

internal static class CacheHeaders
{
    /// <summary>Hashed Vite assets are immutable; index.html must always revalidate.</summary>
    public static void Apply(HttpContext context, string fileName)
    {
        var path = context.Request.Path.Value ?? string.Empty;
        context.Response.Headers.CacheControl =
            path.StartsWith("/assets/", StringComparison.Ordinal) && !fileName.EndsWith(".html", StringComparison.Ordinal)
                ? "public, max-age=31536000, immutable"
                : "no-cache";
    }

    /// <summary>
    /// Safety net for HTML served outside the static file middleware (SPA fallback for "/" and client
    /// routes): without an explicit header browsers cache it heuristically and keep old deployments.
    /// </summary>
    public static void EnsureHtmlRevalidates(HttpResponse response)
    {
        ArgumentNullException.ThrowIfNull(response);
        if (string.IsNullOrEmpty(response.Headers.CacheControl)
            && response.ContentType?.StartsWith("text/html", StringComparison.OrdinalIgnoreCase) == true)
        {
            response.Headers.CacheControl = "no-cache";
        }
    }
}
