using Microsoft.AspNetCore.Http;
using TrafficSim.Api.Http;

namespace TrafficSim.Api.Tests;

public class CacheHeadersTests
{
    [Theory]
    [InlineData("/assets/index-abc.js", "index-abc.js", "public, max-age=31536000, immutable")]
    [InlineData("/", "index.html", "no-cache")]
    [InlineData("/favicon.svg", "favicon.svg", "no-cache")]
    public void Static_files(string path, string file, string expected)
    {
        var context = new DefaultHttpContext();
        context.Request.Path = path;

        CacheHeaders.Apply(context, file);

        Assert.Equal(expected, context.Response.Headers.CacheControl.ToString());
    }

    [Fact]
    public void Html_without_header_revalidates_but_explicit_headers_win()
    {
        var html = new DefaultHttpContext().Response;
        html.ContentType = "text/html; charset=utf-8";
        CacheHeaders.EnsureHtmlRevalidates(html);
        Assert.Equal("no-cache", html.Headers.CacheControl.ToString());

        var json = new DefaultHttpContext().Response;
        json.ContentType = "application/json";
        CacheHeaders.EnsureHtmlRevalidates(json);
        Assert.Empty(json.Headers.CacheControl.ToString());

        var explicitHtml = new DefaultHttpContext().Response;
        explicitHtml.ContentType = "text/html";
        explicitHtml.Headers.CacheControl = "no-store";
        CacheHeaders.EnsureHtmlRevalidates(explicitHtml);
        Assert.Equal("no-store", explicitHtml.Headers.CacheControl.ToString());
    }
}
