using TrafficSim.Application.Demo;

namespace TrafficSim.Application.Tests.Demo;

public class DemoTownTests
{
    [Fact]
    public void The_demo_town_has_signals_crossings_give_way_and_residential_junctions()
    {
        // #145: replaces the ring road demo.
        var package = DemoTown.Build();

        Assert.Null(package.BaselineId);
        Assert.Equal([DemoTown.Attribution], package.Attribution);
        var controls = package.Nodes.GroupBy(n => n.Control).ToDictionary(g => g.Key, g => g.Count());
        Assert.True(controls.GetValueOrDefault("signal") >= 2, string.Join(", ", controls));
        Assert.True(controls.GetValueOrDefault("priority") >= 2, string.Join(", ", controls));
        Assert.True(controls.GetValueOrDefault("boundary") >= 6, string.Join(", ", controls));
        Assert.NotEmpty(package.Signals);
        var crossings = package.Crossings ?? [];
        Assert.Contains(crossings, c => c.Kind == "zebra");
        Assert.Contains(crossings, c => c.Kind == "signal");
        Assert.Contains(package.Links, l => l.Name == "Hauptstraße");
        // Compiled once and served as is.
        Assert.Same(DemoTown.GzipPackage, DemoTown.GzipPackage);
    }
}
