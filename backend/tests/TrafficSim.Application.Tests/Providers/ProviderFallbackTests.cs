using TrafficSim.Application.Providers;

namespace TrafficSim.Application.Tests.Providers;

public class ProviderFallbackTests
{
    private sealed record P(string Name, int Priority, string Attribution = "a") : IProvider;

    [Fact]
    public void Orders_by_priority_then_name() =>
        Assert.Equal(["a", "b", "c"], ProviderFallback.Order([new P("c", 5), new P("b", 1), new P("a", 1)]).Select(p => p.Name));

    [Fact]
    public async Task Returns_first_success_and_reports_failures()
    {
        var failures = new List<string>();

        var answer = await ProviderFallback.FirstAvailableAsync(
            [new P("one", 1), new P("two", 2, "attr-two")],
            "test",
            p => p.Name == "one" ? throw new ProviderUnavailableException(p.Name, "down") : Task.FromResult(42),
            (p, _) => failures.Add(p.Name));

        Assert.Equal(42, answer.Value);
        Assert.Equal("two", answer.Provider);
        Assert.Equal("attr-two", answer.Attribution);
        Assert.Equal(["one"], failures);
    }

    [Fact]
    public async Task Throws_when_nothing_is_configured()
    {
        var ex = await Assert.ThrowsAsync<NoProviderAvailableException>(
            () => ProviderFallback.FirstAvailableAsync(Array.Empty<P>(), "widget", _ => Task.FromResult(1)));

        Assert.Contains("No widget provider", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Throws_with_all_failures_when_every_provider_fails()
    {
        var ex = await Assert.ThrowsAsync<NoProviderAvailableException>(
            () => ProviderFallback.FirstAvailableAsync<P, int>(
                [new P("one", 1), new P("two", 2)], "widget", p => throw new ProviderUnavailableException(p.Name, "down")));

        Assert.Equal(2, Assert.IsType<AggregateException>(ex.InnerException).InnerExceptions.Count);
    }

    [Fact]
    public async Task Other_exceptions_are_not_swallowed() =>
        await Assert.ThrowsAsync<InvalidOperationException>(
            () => ProviderFallback.FirstAvailableAsync<P, int>([new P("one", 1)], "widget", _ => throw new InvalidOperationException()));

    [Fact]
    public void Exception_constructors_keep_messages()
    {
        Assert.Equal("m", new NoProviderAvailableException("m").Message);
        Assert.NotNull(new NoProviderAvailableException().Message);
        Assert.IsType<InvalidOperationException>(new NoProviderAvailableException("m", new InvalidOperationException()).InnerException);
        Assert.Equal("unknown", new ProviderUnavailableException().ProviderName);
        Assert.Equal("unknown", new ProviderUnavailableException("m").ProviderName);
        Assert.Equal("unknown", new ProviderUnavailableException("m", new InvalidOperationException()).ProviderName);
    }
}
