"""
Monte Carlo study of per-part Dutch-auction anchoring for a Fusion TWAP.
Usage: python3 scripts/twap/simulation.py [anchors|late|params|all]
Prints the tables and writes build/twap-charts/simulation.json for charts.py. Needs numpy.

Model
- Price of the sold token follows zero-drift GBM, sampled once per block.
- Resolvers are competitive: a part fills at the first block where the curve's offered
  price P <= S * (1 - c), c = resolver all-in cost/margin. They take everything unlocked.
- The order has a hard end at start + duration; the floor (limit price) is L.
Metrics
- cost_at_fill_bps: amount-weighted (S_fill - P) / S_fill, the mechanism's cost.
- shortfall_bps:   (market TWAP - average execution price) / market TWAP, filled part only.
- completion:      share of the order sold before the end.
"""
import json
import os
import sys

import numpy as np

YEAR = 365 * 24 * 3600


def piecewise(tau, anchor, floor, duration, hi=0.10, lo=0.01, lo2=-0.01, d1=15.0, d2_frac=0.8):
    p0, p1, p2 = anchor * (1 + hi), anchor * (1 + lo), anchor * (1 + lo2)
    d2 = d2_frac * duration
    out = np.where(
        tau <= d1, p0 + (p1 - p0) * tau / d1,
        np.where(tau <= d2, p1 + (p2 - p1) * (tau - d1) / (d2 - d1),
                 np.where(tau <= duration, p2 + (floor - p2) * (tau - d2) / (duration - d2), floor)))
    return np.maximum(out, floor)


def linear(tau, top, floor, duration):
    return floor + (top - floor) * np.clip(1 - tau / duration, 0, 1)


def simulate(design, sigma, block_time, duration, parts, auction_frac=1.0, floor_frac=0.95,
             cost_bps=10.0, static_top=0.03, n_paths=4000, seed=7, delay_max=0.0, anchored_start=False,
             oracle_dev=0.005, oracle_heartbeat=3600):
    rng = np.random.default_rng(seed)
    interval = duration / parts
    auction = auction_frac * interval
    c = cost_bps / 1e4
    floor = floor_frac
    delay = rng.uniform(0, delay_max, n_paths) if delay_max > 0 else np.zeros(n_paths)
    start = delay if anchored_start else np.zeros(n_paths)
    horizon = duration + (delay_max if anchored_start else 0.0)
    steps = int(horizon // block_time)
    dt = block_time / YEAR

    S = np.ones(n_paths)
    oracle = np.ones(n_paths)
    oracle_t = np.zeros(n_paths)
    filled = np.zeros(n_paths)
    proceeds = np.zeros(n_paths)
    cost_num = np.zeros(n_paths)
    cost_den = np.zeros(n_paths)
    first_cost_num = np.zeros(n_paths)
    first_cost_den = np.zeros(n_paths)
    twap_sum = np.zeros(n_paths)
    twap_n = np.zeros(n_paths)
    anchor = np.ones(n_paths)
    anchor_next = np.ones(n_paths)
    part_seen = np.full(n_paths, -1)
    filled_in_part = np.zeros(n_paths, dtype=bool)
    ever_filled = np.zeros(n_paths, dtype=bool)

    for k in range(steps):
        t = (k + 1) * block_time
        S = S * np.exp(-0.5 * sigma ** 2 * dt + sigma * np.sqrt(dt) * rng.standard_normal(n_paths))
        stale = (np.abs(S / oracle - 1) > oracle_dev) | (t - oracle_t >= oracle_heartbeat)
        oracle = np.where(stale, S, oracle)
        oracle_t = np.where(stale, t, oracle_t)

        elapsed = t - start
        live = (elapsed >= 0) & (elapsed < duration) & (t >= delay)
        twap_sum += np.where(live, S, 0)
        twap_n += live

        part = np.clip(np.floor(np.maximum(elapsed, 0) / interval), 0, parts - 1).astype(int)
        new_part = part != part_seen
        anchor = np.where(new_part, anchor_next, anchor)
        filled_in_part = np.where(new_part, False, filled_in_part)
        part_seen = part
        tau = np.maximum(elapsed, 0) - part * interval

        if design == 'static-linear':
            P = linear(tau, 1 + static_top, floor, auction)
        elif design == 'static-piecewise':
            P = piecewise(tau, 1.0, floor, auction)
        elif design == 'ratchet':
            P = piecewise(tau, anchor, floor, auction)
        elif design == 'oracle':
            P = piecewise(tau, oracle, floor, auction)
        else:
            raise ValueError(design)

        unlocked = (part + 1) / parts
        avail = np.where(live, unlocked - filled, 0)
        fill = (avail > 1e-12) & (P <= S * (1 - c))
        amt = np.where(fill, avail, 0)
        proceeds += amt * P
        filled += amt
        cost_num += amt * (S - P)
        cost_den += amt * S
        first = fill & ~ever_filled
        first_cost_num += np.where(first, amt * (S - P), 0)
        first_cost_den += np.where(first, amt * S, 0)
        ever_filled |= fill
        anchor_next = np.where(fill & ~filled_in_part, P, anchor_next)
        filled_in_part |= fill

    sold = filled > 0
    market_twap = twap_sum / np.maximum(twap_n, 1)
    avg_price = np.where(sold, proceeds / np.maximum(filled, 1e-18), np.nan)
    shortfall = (market_twap - avg_price) / market_twap * 1e4
    per_path_cost = np.where(cost_den > 0, cost_num / np.maximum(cost_den, 1e-18) * 1e4, np.nan)
    return {
        'cost_at_fill_bps': cost_num.sum() / cost_den.sum() * 1e4,
        'cost_p95_bps': np.nanpercentile(per_path_cost, 95),
        'first_fill_cost_bps': first_cost_num.sum() / max(first_cost_den.sum(), 1e-18) * 1e4,
        'shortfall_bps': np.nanmean(shortfall),
        'completion': filled.mean(),
    }


def sample_path(seed=11, n_paths=1000, sigma=0.6, block_time=12, duration=24 * 3600, percentile=0.9):
    """A GBM path at the given percentile of final prices, one price per block from t = 0."""
    rng = np.random.default_rng(seed)
    steps = int(duration // block_time)
    dt = block_time / YEAR
    log_returns = -0.5 * sigma ** 2 * dt + sigma * np.sqrt(dt) * rng.standard_normal((steps, n_paths))
    paths = np.vstack([np.ones(n_paths), np.exp(np.cumsum(log_returns, axis=0))])
    return paths[:, np.argsort(paths[-1])[int(percentile * n_paths)]]


def trace(prices, design, block_time, duration, parts, auction_frac=1.0, floor_frac=0.95, cost_bps=10.0, static_top=0.03):
    """Replays one price path block by block with the same rules as simulate(), keeping the curve and the fills."""
    interval = duration / parts
    auction = auction_frac * interval
    c = cost_bps / 1e4
    anchor = anchor_next = 1.0
    filled = 0.0
    part_seen = -1
    filled_in_part = False
    curve, fills = [], []
    for k in range(1, len(prices)):
        t = k * block_time
        if t >= duration:
            break
        part = min(int(t // interval), parts - 1)
        if part != part_seen:
            anchor, filled_in_part, part_seen = anchor_next, False, part
        tau = t - part * interval
        if design == 'static-linear':
            price = float(linear(tau, 1 + static_top, floor_frac, auction))
        elif design == 'ratchet':
            price = float(piecewise(tau, anchor, floor_frac, auction))
        else:
            raise ValueError(design)
        curve.append(price)
        available = (part + 1) / parts - filled
        if available > 1e-12 and price <= prices[k] * (1 - c):
            fills.append({'t': t, 'amount': available, 'price': price, 'market': float(prices[k])})
            filled += available
            if not filled_in_part:
                anchor_next = price
            filled_in_part = True
    cost = sum(f['amount'] * (f['market'] - f['price']) for f in fills) / sum(f['amount'] * f['market'] for f in fills) * 1e4
    return {'curve': curve, 'fills': fills, 'cost_bps': cost}


def table(title, rows):
    print(f'\n## {title}')
    print(f"{'design':38s} {'cost@fill':>10s} {'p95 path':>9s} {'1st fill':>9s} {'vs TWAP':>9s} {'sold':>7s}")
    for name, r in rows:
        print(f"{name:38s} {r['cost_at_fill_bps']:10.1f} {r['cost_p95_bps']:9.1f} {r['first_fill_cost_bps']:9.1f} "
              f"{r['shortfall_bps']:9.1f} {100 * r['completion']:6.1f}%")


def params():
    tops = [(top, simulate(design='static-linear', sigma=0.6, block_time=12, duration=4 * 3600, parts=24, cost_bps=10.0, static_top=top))
            for top in (0.01, 0.03, 0.05, 0.10)]
    table('Static curve top premium (4h, 24 parts, D=interval, Ethereum, sigma=60%)', [(f'top +{int(t * 100)}%', r) for t, r in tops])
    intervals = [(parts, simulate(design='static-linear', sigma=0.6, block_time=12, duration=4 * 3600, parts=parts, cost_bps=10.0),
                  simulate(design='ratchet', sigma=0.6, block_time=12, duration=4 * 3600, parts=parts, cost_bps=10.0)) for parts in (12, 24, 48)]
    table('Interval length (4h, D=interval, Ethereum, sigma=60%)',
          [row for parts, static, ratchet in intervals for row in ((f'{parts} parts, static +3%', static), (f'{parts} parts, ratchet', ratchet))])
    return {
        'top_premium': [{'top': t, **r} for t, r in tops],
        'interval': [{'parts': p, 'minutes': 240 // p, 'static': s, 'ratchet': r} for p, s, r in intervals],
    }


DESIGNS = [
    ('static linear +3%..floor, D=interval/2', dict(design='static-linear', auction_frac=0.5)),
    ('static linear +3%..floor, D=interval', dict(design='static-linear', auction_frac=1.0)),
    ('static piecewise around arrival, D=interval', dict(design='static-piecewise')),
    ('ratchet on previous part, D=interval', dict(design='ratchet')),
    ('oracle (0.5% deviation), D=interval', dict(design='oracle')),
]
CHAINS = {'Ethereum': (12, 10.0), 'L2': (2, 5.0)}
LATE = [
    ('fixed start, D=interval/2', dict(design='static-linear', auction_frac=0.5)),
    ('fixed start, D=interval', dict(design='static-linear', auction_frac=1.0)),
    ('start anchored to announcement, D=interval', dict(design='static-linear', auction_frac=1.0, anchored_start=True)),
]


def main(which):
    data = {}
    if which in ('all', 'anchors'):
        data['anchors'] = []
        for sigma in (0.6, 1.2):
            for duration, parts in ((4 * 3600, 24), (24 * 3600, 48)):
                for chain, (bt, cost) in CHAINS.items():
                    rows = [(n, simulate(sigma=sigma, block_time=bt, duration=duration, parts=parts, cost_bps=cost, **kw)) for n, kw in DESIGNS]
                    table(f'sigma={int(sigma * 100)}%/yr, {duration // 3600}h in {parts} parts, {chain} (c={cost:g} bps)', rows)
                    data['anchors'].append({'sigma': sigma, 'hours': duration // 3600, 'parts': parts, 'chain': chain, 'cost_bps': cost,
                                            'results': {n: r for n, r in rows}})
    if which in ('all', 'late'):
        rows = [(n, simulate(sigma=0.6, block_time=12, duration=4 * 3600, parts=24, cost_bps=10.0, delay_max=3600, **kw)) for n, kw in LATE]
        table('Late signature: fillable 0-60 min after the signed start (4h, 24 parts, Ethereum, sigma=60%)', rows)
        data['late'] = {n: r for n, r in rows}
    if which in ('all', 'params'):
        data['params'] = params()
    if which == 'all':
        prices = sample_path()
        data['sample_path'] = {
            'block_time': 12, 'parts': 48, 'hours': 24, 'sigma': 0.6, 'seed': 11, 'percentile': 0.9,
            'prices': [float(p) for p in prices],
            'static': trace(prices, 'static-linear', 12, 24 * 3600, 48),
            'ratchet': trace(prices, 'ratchet', 12, 24 * 3600, 48),
        }
        out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'build', 'twap-charts')
        os.makedirs(out, exist_ok=True)
        with open(os.path.join(out, 'simulation.json'), 'w') as f:
            json.dump(data, f, default=float)
        print(f'\nwrote {os.path.normpath(os.path.join(out, "simulation.json"))}')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'all')
