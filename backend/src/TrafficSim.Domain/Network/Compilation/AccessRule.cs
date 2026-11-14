namespace TrafficSim.Domain.Network.Compilation;

/// <summary>Vehicle class restrictions per way and lane (#27).</summary>
public static class AccessRule
{
    private static readonly string[] Restricted = ["destination", "private", "delivery", "customers", "agricultural", "forestry"];

    /// <summary>Classes allowed on the whole way and whether through traffic is allowed.</summary>
    public static (VehicleClasses Allowed, bool ThroughTraffic) ForWay(IReadOnlyDictionary<string, string> tags, RoadClass roadClass)
    {
        ArgumentNullException.ThrowIfNull(tags);
        var allowed = roadClass == RoadClass.Busway ? VehicleClasses.Bus : VehicleClasses.All;
        var through = true;

        var general = Tags.Get(tags, "motor_vehicle") ?? Tags.Get(tags, "vehicle") ?? Tags.Get(tags, "access");
        if (Tags.IsNo(general))
        {
            allowed = VehicleClasses.None;
        }
        else if (general is not null && Restricted.Contains(general))
        {
            through = false;
        }

        if (Tags.IsNo(Tags.Get(tags, "motorcar")))
        {
            allowed &= ~(VehicleClasses.Car | VehicleClasses.Van);
        }

        if (Tags.IsNo(Tags.Get(tags, "hgv")))
        {
            allowed &= ~VehicleClasses.Truck;
        }

        if (Tags.IsNo(Tags.Get(tags, "motorcycle")))
        {
            allowed &= ~VehicleClasses.Motorcycle;
        }

        var bus = Tags.Get(tags, "bus") ?? Tags.Get(tags, "psv");
        if (Tags.IsYes(bus) || bus == "permissive")
        {
            allowed |= VehicleClasses.Bus;
        }
        else if (Tags.IsNo(bus))
        {
            allowed &= ~VehicleClasses.Bus;
        }

        return (allowed, through);
    }

    /// <summary>Applies <c>bus:lanes</c>, <c>psv:lanes</c>, <c>hgv:lanes</c>, <c>access:lanes</c> to one lane.</summary>
    public static VehicleClasses ForLane(VehicleClasses wayAllowed, string? bus, string? hgv, string? access)
    {
        var allowed = wayAllowed;
        if (Tags.IsNo(access))
        {
            return VehicleClasses.None;
        }

        if (bus == "designated" || (Tags.IsYes(bus) && wayAllowed == VehicleClasses.None))
        {
            return VehicleClasses.Bus;
        }

        if (Tags.IsNo(bus))
        {
            allowed &= ~VehicleClasses.Bus;
        }

        if (Tags.IsNo(hgv))
        {
            allowed &= ~VehicleClasses.Truck;
        }

        return allowed;
    }
}
