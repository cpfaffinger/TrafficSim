using System.Diagnostics;
using Microsoft.Extensions.Logging;

namespace TrafficSim.Providers.Http;

/// <summary>Records metrics and structured logs for every provider request (after cache, before retries).</summary>
internal sealed partial class ProviderTelemetryHandler(string provider, ProviderMetrics metrics, ILogger<ProviderTelemetryHandler> logger)
    : DelegatingHandler
{
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var started = Stopwatch.GetTimestamp();
        var path = request.RequestUri?.AbsolutePath ?? string.Empty;
        try
        {
            var response = await base.SendAsync(request, cancellationToken).ConfigureAwait(false);
            var elapsed = Stopwatch.GetElapsedTime(started).TotalMilliseconds;
            var outcome = response.IsSuccessStatusCode ? "success" : "http_error";
            metrics.Record(provider, outcome, elapsed);
            if (response.IsSuccessStatusCode)
            {
                LogRequest(provider, request.Method.Method, path, (int)response.StatusCode, elapsed);
            }
            else
            {
                LogHttpError(provider, request.Method.Method, path, (int)response.StatusCode, elapsed);
            }

            return response;
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            var elapsed = Stopwatch.GetElapsedTime(started).TotalMilliseconds;
            metrics.Record(provider, "exception", elapsed);
            LogException(provider, request.Method.Method, path, ex.GetType().Name, elapsed);
            throw;
        }
    }

    [LoggerMessage(Level = LogLevel.Debug, Message = "Provider {Provider} {Method} {Path} -> {Status} in {ElapsedMs:F0} ms")]
    private partial void LogRequest(string provider, string method, string path, int status, double elapsedMs);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Provider {Provider} {Method} {Path} -> {Status} in {ElapsedMs:F0} ms")]
    private partial void LogHttpError(string provider, string method, string path, int status, double elapsedMs);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Provider {Provider} {Method} {Path} failed with {Error} after {ElapsedMs:F0} ms")]
    private partial void LogException(string provider, string method, string path, string error, double elapsedMs);
}
