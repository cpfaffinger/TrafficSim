namespace TrafficSim.Domain.Network;

/// <summary>A point or vector in the local East-North-Up plane, metres (ADR-0011).</summary>
public readonly record struct Vec3(double X, double Y, double Z = 0)
{
    public double Length => Math.Sqrt((X * X) + (Y * Y) + (Z * Z));

    public double PlanarLength => Math.Sqrt((X * X) + (Y * Y));

    public static Vec3 operator +(Vec3 a, Vec3 b) => new(a.X + b.X, a.Y + b.Y, a.Z + b.Z);

    public static Vec3 operator -(Vec3 a, Vec3 b) => new(a.X - b.X, a.Y - b.Y, a.Z - b.Z);

    public static Vec3 operator *(Vec3 a, double s) => new(a.X * s, a.Y * s, a.Z * s);

    public static Vec3 Add(Vec3 a, Vec3 b) => a + b;

    public static Vec3 Subtract(Vec3 a, Vec3 b) => a - b;

    public static Vec3 Multiply(Vec3 a, double s) => a * s;

    /// <summary>Unit vector in the horizontal plane (zero vector stays zero).</summary>
    public Vec3 PlanarNormalized()
    {
        var l = PlanarLength;
        return l < 1e-12 ? new Vec3(0, 0) : new Vec3(X / l, Y / l);
    }

    /// <summary>Right-hand normal in the horizontal plane (for a unit direction).</summary>
    public Vec3 RightNormal() => new(Y, -X);

    public Vec3 WithZ(double z) => this with { Z = z };
}
