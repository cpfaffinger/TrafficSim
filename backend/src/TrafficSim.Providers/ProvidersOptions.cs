namespace TrafficSim.Providers;

/// <summary>Root configuration section "Providers" (ADR-0004).</summary>
public sealed class ProvidersOptions
{
    public const string SectionName = "Providers";

    /// <summary>Contact (URL or e-mail) included in the User-Agent, required by community services.</summary>
    public string Contact { get; set; } = "https://github.com/cpfaffinger/TrafficSim";

    public ResponseCacheOptions Cache { get; set; } = new();

    public PhotonOptions Photon { get; set; } = new();

    public NominatimOptions Nominatim { get; set; } = new();

    public OverpassOptions Overpass { get; set; } = new();

    public GeofabrikOptions Geofabrik { get; set; } = new();

    public GoogleOptions Google { get; set; } = new();

    public BasemapOptions Basemap { get; set; } = new();

    public TerrainTilesOptions TerrainTiles { get; set; } = new();
}

/// <summary>Persistent response cache shared by all providers.</summary>
public sealed class ResponseCacheOptions
{
    /// <summary>Directory for cached responses; empty disables caching.</summary>
    public string? Directory { get; set; }
}

/// <summary>Settings shared by every HTTP provider.</summary>
public class HttpProviderOptions
{
    public bool Enabled { get; set; } = true;

    public Uri BaseUrl { get; set; } = new("http://localhost/");

    public int Priority { get; set; } = 100;

    public TimeSpan Timeout { get; set; } = TimeSpan.FromSeconds(10);

    /// <summary>Client-side request rate limit; null = unlimited. Community services publish usage policies.</summary>
    public double? RequestsPerSecond { get; set; }

    /// <summary>How long successful GET responses are cached; zero disables caching for this provider.</summary>
    public TimeSpan CacheTtl { get; set; } = TimeSpan.Zero;
}

public sealed class PhotonOptions : HttpProviderOptions
{
    public PhotonOptions()
    {
        BaseUrl = new Uri("https://photon.komoot.io/");
        Priority = 10;
        CacheTtl = TimeSpan.FromDays(1);
    }

    /// <summary>Whether this Photon instance also answers reverse geocoding requests.</summary>
    public bool Reverse { get; set; } = true;
}

/// <summary>Nominatim; the public instance allows at most one request per second.</summary>
public sealed class NominatimOptions : HttpProviderOptions
{
    public NominatimOptions()
    {
        BaseUrl = new Uri("https://nominatim.openstreetmap.org/");
        Priority = 20;
        RequestsPerSecond = 1;
        CacheTtl = TimeSpan.FromDays(7);
    }
}

/// <summary>Overpass API community instances (primary + mirrors).</summary>
public sealed class OverpassOptions : HttpProviderOptions
{
    public OverpassOptions()
    {
        BaseUrl = new Uri("https://overpass-api.de/api/");
        Priority = 10;
        Timeout = TimeSpan.FromSeconds(180);
        RequestsPerSecond = 0.5;
        CacheTtl = TimeSpan.FromDays(1);
    }

    /// <summary>Further instances tried in order when the primary fails.</summary>
    public IList<Uri> Mirrors { get; } = [new Uri("https://overpass.private.coffee/api/")];

    /// <summary>Largest bounding box accepted per request.</summary>
    public double MaxAreaSquareKilometers { get; set; } = 50;

    /// <summary>Server-side query timeout in seconds.</summary>
    public int QueryTimeoutSeconds { get; set; } = 120;
}

/// <summary>Geofabrik regional PBF extracts for areas too large for Overpass.</summary>
public sealed class GeofabrikOptions : HttpProviderOptions
{
    public GeofabrikOptions()
    {
        BaseUrl = new Uri("https://download.geofabrik.de/");
        Priority = 50;
        Timeout = TimeSpan.FromMinutes(5);
        RequestsPerSecond = 1;
    }

    /// <summary>Directory for downloaded extracts; empty disables the source.</summary>
    public string? Directory { get; set; }

    /// <summary>Extracts and the region index older than this are downloaded again.</summary>
    public TimeSpan MaxAge { get; set; } = TimeSpan.FromDays(7);

    public double MaxAreaSquareKilometers { get; set; } = 2500;

    /// <summary>Nodes within this margin around the area are kept so ways are not cut at the border.</summary>
    public double MarginMetres { get; set; } = 1000;
}

/// <summary>Google Maps Geocoding API — commercial, disabled by default (C-08).</summary>
public sealed class GoogleOptions : HttpProviderOptions
{
    public GoogleOptions()
    {
        Enabled = false;
        BaseUrl = new Uri("https://maps.googleapis.com/");
        Priority = 90;
    }

    /// <summary>API key; the adapter stays disabled while this is empty.</summary>
    public string? ApiKey { get; set; }
}

/// <summary>Vector basemap tiles consumed directly by the browser.</summary>
public sealed class BasemapOptions
{
    public bool Enabled { get; set; } = true;

    public Uri StyleUrl { get; set; } = new("https://tiles.openfreemap.org/styles/positron");
}

/// <summary>AWS Open Data Terrain Tiles (Terrarium PNG) for terrain elevation (ADR-0018); disabling it keeps networks flat.</summary>
public sealed class TerrainTilesOptions : HttpProviderOptions
{
    public TerrainTilesOptions()
    {
        BaseUrl = new Uri("https://s3.amazonaws.com/elevation-tiles-prod/");
        Priority = 10;
        Timeout = TimeSpan.FromSeconds(30);
        RequestsPerSecond = 20;
        CacheTtl = TimeSpan.FromDays(30);
    }

    /// <summary>Highest zoom level used (0–15; 13 ≈ 13–19 m pixels at mid latitudes).</summary>
    public int Zoom { get; set; } = 13;

    /// <summary>Most tiles fetched per import; larger areas use a lower zoom.</summary>
    public int MaxTiles { get; set; } = 64;
}
