namespace TrafficSim.Application.Providers;

/// <summary>Raised by provider adapters when the provider cannot serve a request.</summary>
public sealed class ProviderUnavailableException : Exception
{
    public ProviderUnavailableException()
    {
        ProviderName = "unknown";
    }

    public ProviderUnavailableException(string message)
        : base(message)
    {
        ProviderName = "unknown";
    }

    public ProviderUnavailableException(string message, Exception innerException)
        : base(message, innerException)
    {
        ProviderName = "unknown";
    }

    public ProviderUnavailableException(string providerName, string message, Exception? innerException = null)
        : base($"Provider '{providerName}' is unavailable: {message}", innerException)
    {
        ProviderName = providerName;
    }

    public string ProviderName { get; }
}
