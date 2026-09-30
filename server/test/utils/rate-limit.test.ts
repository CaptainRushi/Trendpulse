import { describe, expect, it } from "vitest";
import { DomainRateLimiter } from "../../src/utils/rate-limit.js";

describe("DomainRateLimiter", () => {
  it("spaces request starts on the same domain by gapMs", async () => {
    const starts: number[] = [];
    const sleeps: number[] = [];
    let clock = 0;
    const limiter = new DomainRateLimiter({
      gapMs: 100,
      now: () => clock,
      // Absolute wake target on a shared clock: reservation 100ms out must
      // land at t=100 even when another sleeper already advanced the clock.
      sleep: async (ms) => {
        const target = clock + ms;
        await new Promise((resolve) => setTimeout(resolve, 0));
        sleeps.push(ms);
        clock = Math.max(clock, target);
      },
    });

    const run = async (): Promise<void> => {
      await limiter.run("a.com", async () => {
        starts.push(clock);
      });
    };
    await Promise.all([run(), run(), run()]);

    // Requests 2 and 3 reserve slots 100ms and 200ms after the first.
    expect(sleeps).toEqual([100, 200]);
    expect(starts).toEqual([0, 100, 200]);
  });

  it("gap override of 0 lets same-domain requests start together", async () => {
    const starts: number[] = [];
    let clock = 0;
    const limiter = new DomainRateLimiter({
      gapMs: 1000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    await Promise.all(
      [0, 1, 2].map(() => limiter.run("a.com", async () => { starts.push(clock); }, 0)),
    );
    expect(starts).toEqual([0, 0, 0]);
  });

  it("different domains do not share the gap", async () => {
    const starts: Record<string, number> = {};
    let clock = 0;
    const limiter = new DomainRateLimiter({
      gapMs: 1000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    await Promise.all([
      limiter.run("a.com", async () => { starts.a = clock; }),
      limiter.run("b.com", async () => { starts.b = clock; }),
    ]);
    expect(starts).toEqual({ a: 0, b: 0 });
  });

  it("caps concurrent domains at maxConcurrentDomains", async () => {
    let inFlight = 0;
    let maxSeen = 0;
    const limiter = new DomainRateLimiter({ gapMs: 0, maxConcurrentDomains: 2 });
    const work = (domain: string) =>
      limiter.run(domain, async () => {
        inFlight += 1;
        maxSeen = Math.max(maxSeen, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 10));
        inFlight -= 1;
      });

    await Promise.all([
      work("a.com"),
      work("b.com"),
      work("c.com"),
      work("d.com"),
      work("e.com"),
    ]);
    expect(maxSeen).toBeLessThanOrEqual(2);
  });

  it("does not throttle a second request from a domain already in flight", async () => {
    // HN-style: one domain, many concurrent requests — cross-domain cap (2)
    // must not serialize them.
    let inFlight = 0;
    let maxSeen = 0;
    const limiter = new DomainRateLimiter({ gapMs: 0, maxConcurrentDomains: 2 });
    const work = () =>
      limiter.run("hn.com", async () => {
        inFlight += 1;
        maxSeen = Math.max(maxSeen, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 10));
        inFlight -= 1;
      });
    await Promise.all([work(), work(), work(), work()]);
    expect(maxSeen).toBeGreaterThan(2);
  });

  it("releases the domain slot even when fn throws", async () => {
    const limiter = new DomainRateLimiter({ gapMs: 0, maxConcurrentDomains: 1 });
    await expect(
      limiter.run("a.com", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // If the slot leaked, this would hang; use a race to fail fast.
    const ok = await Promise.race([
      limiter.run("b.com", async () => "done"),
      new Promise((resolve) => {
        setTimeout(() => {
          resolve("timeout");
        }, 500);
      }),
    ]);
    expect(ok).toBe("done");
  });
});
