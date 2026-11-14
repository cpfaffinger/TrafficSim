namespace TrafficSim.Domain.Network;

/// <summary>OSM <c>highway=*</c> classes that carry motor vehicle traffic.</summary>
public enum RoadClass
{
    Motorway,
    MotorwayLink,
    Trunk,
    TrunkLink,
    Primary,
    PrimaryLink,
    Secondary,
    SecondaryLink,
    Tertiary,
    TertiaryLink,
    Unclassified,
    Residential,
    LivingStreet,
    Service,
    Road,
    Busway,
}

/// <summary>Physical structure of a link (ADR-0016).</summary>
public enum Structure
{
    None,
    Bridge,
    Tunnel,
    Covered,
}

/// <summary>How a node controls traffic.</summary>
public enum NodeControl
{
    None,
    Priority,
    RightBeforeLeft,
    AllWayStop,
    Signal,
    Roundabout,
    LevelCrossing,
    Boundary,
}

/// <summary>Vehicle classes allowed on a lane.</summary>
[Flags]
public enum VehicleClasses
{
    None = 0,
    Car = 1,
    Van = 2,
    Truck = 4,
    Bus = 8,
    Motorcycle = 16,
    All = Car | Van | Truck | Bus | Motorcycle,
}

/// <summary>Turn markings painted on a lane (OSM <c>turn:lanes</c>).</summary>
[Flags]
public enum TurnMarkings
{
    None = 0,
    Left = 1,
    SlightLeft = 2,
    SharpLeft = 4,
    Through = 8,
    Right = 16,
    SlightRight = 32,
    SharpRight = 64,
    Reverse = 128,
    MergeToLeft = 256,
    MergeToRight = 512,
}

/// <summary>Geometric movement type of a connector.</summary>
public enum Turn
{
    Through,
    Left,
    Right,
    SlightLeft,
    SlightRight,
    SharpLeft,
    SharpRight,
    Reverse,
}

/// <summary>Marking between two adjacent lanes of the same direction (ADR-0016).</summary>
public enum LaneMarking
{
    Dashed,
    Solid,
    DoubleSolid,

    /// <summary>Solid on the left side, dashed on the right: only the right lane may cross.</summary>
    SolidDashed,

    /// <summary>Dashed on the left side, solid on the right: only the left lane may cross.</summary>
    DashedSolid,
}

/// <summary>Marking left of a link's leftmost lane.</summary>
public enum EdgeMarking
{
    CentreDashed,
    CentreSolid,
    DoubleSolid,
    Edge,
}

/// <summary>Right-of-way rule of a connector.</summary>
public enum ConnectorPriority
{
    Major,
    Minor,
    Stop,
    Signal,
    RightBeforeLeft,
    RoundaboutEntry,
    RoundaboutRing,
}
