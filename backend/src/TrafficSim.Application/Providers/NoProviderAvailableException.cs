namespace TrafficSim.Application.Providers;

/// <summary>Raised when no configured provider of a capability could answer.</summary>
public sealed class NoProviderAvailableException : Exception
{
    public NoProviderAvailableException()
    {
    }

    public NoProviderAvailableException(string message)
        : base(message)
    {
    }

    public NoProviderAvailableException(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}
