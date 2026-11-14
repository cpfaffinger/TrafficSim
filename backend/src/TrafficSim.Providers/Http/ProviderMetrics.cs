using System.Diagnostics;
using System.Diagnostics.Metrics;

namespace TrafficSim.Providers.Http;

/// <summary>Metrics of the fetch pipeline (meter "TrafficSim.Providers").</summary>
public sealed class ProviderMetrics
{
    public const string MeterName = "TrafficSim.Providers";

    private readonly Counter<long> _requests;
    private readonly Histogram<double> _duration;

    public ProviderMetrics(IMeterFactory meterFactory)
    {
        ArgumentNullException.ThrowIfNull(meterFactory);
        var meter = meterFactory.Create(MeterName);
        _requests = meter.CreateCounter<long>("trafficsim.provider.requests", description: "Provider requests by outcome");
        _duration = meter.CreateHistogram<double>("trafficsim.provider.duration", unit: "ms", description: "Provider request duration");
    }

    /// <param name="provider">Provider name.</param>
    /// <param name="outcome">success | cache_hit | http_error | exception.</param>
    /// <param name="milliseconds">Elapsed time.</param>
    public void Record(string provider, string outcome, double milliseconds)
    {
        var tags = new TagList { { "provider", provider }, { "outcome", outcome } };
        _requests.Add(1, tags);
        _duration.Record(milliseconds, tags);
    }
}
