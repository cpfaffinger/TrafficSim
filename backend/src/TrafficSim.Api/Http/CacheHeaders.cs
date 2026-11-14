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
}
