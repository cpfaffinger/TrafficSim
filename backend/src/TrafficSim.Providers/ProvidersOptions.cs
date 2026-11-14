namespace TrafficSim.Providers;

/// <summary>Root configuration section "Providers" (ADR-0004).</summary>
public sealed class ProvidersOptions
{
    public const string SectionName = "Providers";

    /// <summary>Contact (URL or e-mail) included in the User-Agent, required by community services.</summary>
    public string Contact { get; set; } = "https://github.com/cpfaffinger/TrafficSim";

    public PhotonOptions Photon { get; set; } = new();
}

/// <summary>Settings shared by every HTTP provider.</summary>
public class HttpProviderOptions
{
    public bool Enabled { get; set; } = true;

    public Uri BaseUrl { get; set; } = new("http://localhost/");

    public int Priority { get; set; } = 100;

    public TimeSpan Timeout { get; set; } = TimeSpan.FromSeconds(10);
}

public sealed class PhotonOptions : HttpProviderOptions
{
    public PhotonOptions()
    {
        BaseUrl = new Uri("https://photon.komoot.io/");
        Priority = 10;
    }
}
