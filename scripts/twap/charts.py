"""
Renders the TWAP charts from build/twap-charts/onchain.json (scripts/twap/chart-data.js) and
build/twap-charts/simulation.json (scripts/twap/simulation.py) into PNG files next to them.
Usage: python3 scripts/twap/charts.py   Needs matplotlib.
"""
import json
import os
import textwrap

import matplotlib

matplotlib.use('Agg')
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.ticker import FuncFormatter  # noqa: E402

OUT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'build', 'twap-charts'))

C = {
    'market': '#374151', 'twap': '#2563eb', 'fusion': '#9ca3af', 'fill': '#f59e0b', 'fill_edge': '#92400e',
    'limit': '#dc2626', 'unlocked': '#bfdbfe', 'filled': '#1d4ed8', 'static': '#2563eb', 'ratchet': '#16a34a',
    'oracle': '#7c3aed', 'p95': '#f59e0b', 'bad': '#dc2626', 'neutral': '#9ca3af', 'muted': '#6b7280',
    'shade': '#f3f4f6', 'signing': '#fee2e2',
}

plt.rcParams.update({
    'figure.dpi': 160, 'savefig.dpi': 160, 'font.size': 10, 'axes.titlesize': 11, 'axes.titleweight': 'bold',
    'axes.titlelocation': 'left', 'axes.labelsize': 10, 'axes.spines.top': False, 'axes.spines.right': False,
    'axes.grid': True, 'grid.color': '#e5e7eb', 'grid.linewidth': 0.8, 'axes.edgecolor': '#9ca3af',
    'legend.frameon': False, 'legend.fontsize': 9, 'figure.facecolor': 'white', 'axes.axisbelow': True,
})


def header(fig, title, subtitle, source, top=0.84, bottom=0.11):
    fig.text(0.012, 0.985, title, ha='left', va='top', fontsize=14, fontweight='bold')
    width = int(fig.get_figwidth() * 13.4)
    fig.text(0.012, 0.93, '\n'.join(textwrap.wrap(subtitle, width)), ha='left', va='top', fontsize=9.5, color=C['muted'])
    fig.text(0.012, 0.012, source, ha='left', va='bottom', fontsize=8, color=C['muted'])
    fig.subplots_adjust(top=top, bottom=bottom, left=0.065, right=0.985)


def save(fig, name):
    path = os.path.join(OUT, name)
    fig.savefig(path)
    plt.close(fig)
    print(f'wrote {path}')


def pct(value, base):
    return float('nan') if value is None else (value / base - 1) * 100


def onchain_source(meta):
    return f"Source: scripts/twap/chart-data.js on Hardhat · Limit Order Protocol v4 + SimpleSettlement + FusionTwap · commit {meta['commit']}"


def price_curve(onchain):
    curve = onchain['curve']
    fig, ax = plt.subplots(figsize=(11, 5.4))
    top = max(curve['twap'])
    for i in range(curve['parts']):
        start = i * curve['interval'] / 60
        if i % 2 == 0:
            ax.axvspan(start, start + curve['interval'] / 60, color=C['shade'], zorder=0, lw=0)
        ax.text(start + curve['interval'] / 120, top * 1.06, f'Part {i + 1}', ha='center', color=C['muted'], fontsize=9)
    ax.plot(curve['minutes'], curve['twap'], color=C['twap'], lw=2.6, label='FusionTwap: the auction restarts at every part')
    ax.plot(curve['minutes'], curve['fusion'], color='#111827', lw=1.6, ls=(0, (5, 4)), zorder=4,
            label='One Fusion order with the same auction')
    ax.axhline(0, color=C['limit'], lw=1.3, ls=':', label="The order's limit price")
    ax.set_xlim(0, curve['parts'] * curve['interval'] / 60)
    ax.set_ylim(-0.8, top * 1.13)
    ax.set_xlabel('Minutes since the TWAP start')
    ax.set_ylabel("Quote above the order's limit price (%)")
    ax.legend(loc='lower left', bbox_to_anchor=(0, 1.0), ncol=3, fontsize=8.8)
    header(
        fig,
        'What FusionTwap quotes to resolvers, read from the contracts',
        f"Getter quotes every 15 s for one part of a 4-part TWAP with 10-minute parts and auctions starting {curve['initialRateBumpPct']}% above the limit price. "
        f"All {curve['samples']} quotes equal the independent model of the settlement's pricing ({curve['maxDeviationWei']} wei difference).",
        onchain_source(onchain['meta']),
        top=0.8,
    )
    save(fig, 'twap_onchain_price_curve.png')


def execution_axes(ax, scenario, meta, color=C['twap'], label_curve=True):
    arrival = meta['arrivalPrice']
    minutes = [b['t'] / 60 for b in scenario['blocks']]
    ax.plot(minutes, [pct(b['market'], arrival) for b in scenario['blocks']], color=C['market'], lw=1.5, label='Market price (simulated)')
    ax.plot(minutes, [pct(b['price'], arrival) for b in scenario['blocks']], color=color, lw=1.6,
            label='FusionTwap quote for one part' if label_curve else None)
    ax.axhline(pct(meta['limitPrice'], arrival), color=C['limit'], lw=1.2, ls=':', label="The order's limit price")
    sizes = [60 + 70 * f['parts'] for f in scenario['fills']]
    ax.scatter([f['t'] / 60 for f in scenario['fills']], [pct(f['price'], arrival) for f in scenario['fills']], s=sizes,
               color=C['fill'], edgecolor=C['fill_edge'], linewidth=1, zorder=5, label='On-chain fill (size = parts)')
    ax.set_ylabel('Price vs the arrival price (%)')


def weighted_cost(fills):
    return sum(f['making'] * f['costBps'] for f in fills) / sum(f['making'] for f in fills)


def execution(onchain):
    scenario, meta = onchain['execution'], onchain['meta']
    fig, (ax, bx) = plt.subplots(2, 1, figsize=(11, 7.2), sharex=True, gridspec_kw={'height_ratios': [2.3, 1], 'hspace': 0.12})
    for i in range(scenario['parts']):
        if i % 2 == 0:
            for axis in (ax, bx):
                axis.axvspan(i * scenario['interval'] / 60, (i + 1) * scenario['interval'] / 60, color=C['shade'], zorder=0, lw=0)
    execution_axes(ax, scenario, meta)
    ax.set_ylim(-5.8, 3.6)
    ax.legend(loc='lower left', bbox_to_anchor=(0, 1.0), ncol=4, fontsize=8.8)

    minutes = [b['t'] / 60 for b in scenario['blocks']]
    bx.fill_between(minutes, [b['unlocked'] for b in scenario['blocks']], step='post', color=C['unlocked'], label='Unlocked by the schedule')
    bx.step(minutes, [b['filled'] for b in scenario['blocks']], where='post', color=C['filled'], lw=2, label='Filled on-chain')
    bx.set_ylim(0, 105)
    bx.set_ylabel('Share of the order (%)')
    bx.set_xlabel('Minutes since the TWAP start')
    bx.set_xlim(0, scenario['parts'] * scenario['interval'] / 60)
    bx.legend(loc='upper left')
    header(
        fig,
        f"A {scenario['parts'] * scenario['interval'] // 3600}-hour TWAP in {scenario['parts']} parts, executed on-chain against a simulated market",
        f"A resolver bot quotes the real getters every {meta['blockTime']} s block and fills everything unlocked once the quote is at least "
        f"{meta['resolverCostBps']:g} bps below the market. {len(scenario['fills'])} fills, on average {weighted_cost(scenario['fills']):.1f} bps below the market at each fill.",
        f"{onchain_source(meta)} · market: GBM, σ {int(meta['market']['sigma'] * 100)}%/yr, seed {meta['market']['seed']}",
        top=0.84, bottom=0.08,
    )
    save(fig, 'twap_onchain_execution.png')


def late_start(onchain):
    late, meta = onchain['late'], onchain['meta']
    fig, axes = plt.subplots(1, 2, figsize=(12, 6.0), sharey=True, gridspec_kw={'wspace': 0.06})
    delay = late['delaySeconds'] / 60
    for ax, (name, scenario, title) in zip(axes, [
        ('fixed', late['fixed'], 'Fixed start'),
        ('anchored', late['anchored'], 'Start anchored to the announcement'),
    ]):
        ax.axvspan(0, delay, color=C['signing'], zorder=0, lw=0)
        ax.text(delay / 2, 3.2, 'Safe owners\nstill signing', ha='center', va='top', fontsize=9, color=C['bad'])
        execution_axes(ax, scenario, meta, label_curve=True)
        end = (scenario['anchoredAt'] or 0) / 60 + scenario['parts'] * scenario['interval'] / 60
        ax.axvline(end, color=C['muted'], lw=1, ls='--')
        ax.text(end - 1, -5.6, 'schedule ends', ha='right', va='bottom', fontsize=8.5, color=C['muted'])
        first = scenario['fills'][0]
        ax.annotate(
            f"first fill: {first['parts']} part{'s' if first['parts'] > 1 else ''},\n{first['costBps']:.0f} bps below the market",
            xy=(first['t'] / 60, pct(first['price'], meta['arrivalPrice'])), xytext=(first['t'] / 60 + 18, 1.9),
            arrowprops={'arrowstyle': '->', 'color': C['market'], 'lw': 1}, fontsize=9.5, fontweight='bold',
            bbox={'boxstyle': 'round,pad=0.25', 'fc': 'white', 'ec': 'none', 'alpha': 0.9},
            color=C['bad'] if first['costBps'] > 50 else C['market'],
        )
        ax.set_title(f'{title} · {weighted_cost(scenario["fills"]):.1f} bps on average')
        ax.set_xlabel('Minutes since the signed start')
        ax.set_xlim(0, 9900 / 60)
        ax.set_ylim(-5.8, 3.6)
    axes[1].set_ylabel('')
    handles, labels = axes[0].get_legend_handles_labels()
    fig.legend(handles, labels, loc='lower center', bbox_to_anchor=(0.5, 0.045), ncol=4, fontsize=9)
    header(
        fig,
        'A Safe that signs 45 minutes late, run on-chain',
        'Same market path, order and resolver bot as the execution chart. With a fixed start, the parts missed while the owners sign sell together '
        'at whatever point the current auction has reached. With the start anchored to OrderRegistrator.announcedAt, the schedule starts when the order is announced.',
        onchain_source(meta),
        top=0.82, bottom=0.2,
    )
    save(fig, 'twap_onchain_late_start.png')


def gas(onchain):
    data = onchain['gas']
    labels = ['Plain Fusion\npartial fill', 'FusionTwap part', 'FusionTwap part,\nanchored start']
    keys = ['plain', 'twap', 'anchoredTwap']
    fig, ax = plt.subplots(figsize=(10, 5.2))
    width = 0.36
    xs = range(len(keys))
    first = ax.bar([x - width / 2 for x in xs], [data[k]['first'] for k in keys], width, color=C['twap'], label='First fill of the order')
    later = ax.bar([x + width / 2 for x in xs], [data[k]['later'] for k in keys], width, color='#93c5fd', label='Later fill')
    ax.bar_label(first, labels=[f"{data[k]['first']:,}" for k in keys], padding=3, fontsize=9)
    ax.bar_label(later, labels=[f"{data[k]['later']:,}" for k in keys], padding=3, fontsize=9)
    for i, (k, base) in enumerate([('twap', 'plain'), ('anchoredTwap', 'twap')], start=1):
        delta = data[k]['later'] - data[base]['later']
        ax.text(i, max(data[k]['first'], data[k]['later']) * 1.1, f'+{delta / 1000:.1f}k gas', ha='center', fontsize=10, fontweight='bold', color=C['bad'])
    ax.set_xticks(list(xs), labels)
    ax.set_ylabel('Gas used by the fill transaction')
    ax.yaxis.set_major_formatter(FuncFormatter(lambda v, _: f'{v / 1000:.0f}k'))
    ax.set_ylim(0, max(data[k]['first'] for k in keys) * 1.25)
    ax.legend(loc='upper left')
    header(
        fig,
        'Gas per fill, measured on-chain',
        'A resolver fills 25% of a 100 DAI order and keeps a WETH balance afterwards. The first fill also creates the order\'s remaining-amount slot '
        'and checks the signature, so later parts cost less. Red: overhead against the order type to the left.',
        onchain_source(onchain['meta']),
        top=0.82, bottom=0.15,
    )
    save(fig, 'twap_onchain_gas.png')


SHORT = {
    'static linear +3%..floor, D=interval/2': 'Static\n½-interval\nauction',
    'static linear +3%..floor, D=interval': 'Static\nfull-interval\nauction',
    'static piecewise around arrival, D=interval': 'Static\nfine steps\nnear arrival',
    'ratchet on previous part, D=interval': 'Ratchet\non previous\npart',
    'oracle (0.5% deviation), D=interval': 'Oracle\n0.5%\ndeviation',
}
SIM_SOURCE = 'Source: scripts/twap/simulation.py · 4,000 GBM paths per cell, sampled every block · competitive resolvers fill at the first block where the curve ≤ market × (1 − margin)'


def anchoring(sim):
    cells = sim['anchors']
    fig, (ax, bx) = plt.subplots(1, 2, figsize=(13, 5.8), gridspec_kw={'width_ratios': [1, 1.55], 'wspace': 0.16})

    focus = next(c for c in cells if c['hours'] == 24 and c['sigma'] == 0.6 and c['chain'] == 'Ethereum')
    names = list(focus['results'])
    xs = range(len(names))
    width = 0.38
    mean = ax.bar([x - width / 2 for x in xs], [focus['results'][n]['cost_at_fill_bps'] for n in names], width, color=C['twap'], label='Mean')
    p95 = ax.bar([x + width / 2 for x in xs], [focus['results'][n]['cost_p95_bps'] for n in names], width, color=C['p95'], label='95th-percentile path')
    ax.bar_label(mean, fmt='%.0f', padding=2, fontsize=8.5)
    ax.bar_label(p95, fmt='%.0f', padding=2, fontsize=8.5)
    ax.set_xticks(list(xs), [SHORT[n] for n in names], fontsize=8.5)
    ax.set_ylabel('Cost per fill (bps, incl. 10 bps margin)')
    ax.set_title('24 h in 48 parts · Ethereum · σ 60%/yr')
    ax.legend(loc='upper center')

    designs = [('static linear +3%..floor, D=interval', 'Static, full-interval auction (v1)', C['static']),
               ('ratchet on previous part, D=interval', 'Ratchet on the previous part', C['ratchet']),
               ('oracle (0.5% deviation), D=interval', 'Oracle, 0.5% deviation', C['oracle'])]
    width = 0.27
    for j, (key, label, color) in enumerate(designs):
        values = [c['results'][key]['cost_at_fill_bps'] - c['cost_bps'] for c in cells]
        bars = bx.bar([i + (j - 1) * width for i in range(len(cells))], values, width, color=color, label=label)
        bx.bar_label(bars, fmt='%.0f', padding=2, fontsize=7.5)
    bx.set_xticks(range(len(cells)), [f"{c['hours']} h\nσ {int(c['sigma'] * 100)}%\n{c['chain']}" for c in cells], fontsize=8.5)
    bx.set_ylabel('Mean cost above the resolver margin (bps)')
    bx.set_title('Every scenario: what the user loses beyond the resolver margin')
    bx.legend(loc='upper left')
    header(
        fig,
        "Where each part's auction should start: Monte Carlo",
        'Cost is the amount-weighted gap between the market price and the fill price at each fill. The resolver margin is 10 bps on Ethereum '
        '(12 s blocks) and 5 bps on L2s (2 s blocks). "Static" curves are anchored to the signed limit price, as in v1.',
        SIM_SOURCE,
        top=0.82, bottom=0.17,
    )
    save(fig, 'twap_sim_anchoring.png')


def sample_path(sim):
    path = sim['sample_path']
    hours = [k * path['block_time'] / 3600 for k in range(len(path['prices']))]
    fig, axes = plt.subplots(2, 1, figsize=(12, 7.4), sharex=True, sharey=True, gridspec_kw={'hspace': 0.16})
    for ax, key, color, title in [
        (axes[0], 'static', C['static'], 'Anchored to the limit price (v1)'),
        (axes[1], 'ratchet', C['ratchet'], "Re-anchored on the previous part's first fill (v2 ratchet)"),
    ]:
        trace = path[key]
        ax.plot(hours, [(p - 1) * 100 for p in path['prices']], color=C['market'], lw=1.3, label='Market price (simulated)')
        ax.plot(hours[1:len(trace['curve']) + 1], [(p - 1) * 100 for p in trace['curve']], color=color, lw=0.8, alpha=0.9, label='Quote for one part')
        ax.scatter([f['t'] / 3600 for f in trace['fills']], [(f['price'] - 1) * 100 for f in trace['fills']], s=22,
                   color=C['fill'], edgecolor=C['fill_edge'], linewidth=0.7, zorder=5, label='Fill')
        ax.axhline(-5, color=C['limit'], lw=1.1, ls=':', label="The order's limit price")
        if key == 'static':
            ax.axhline(3, color=C['static'], lw=1, ls='--', label="The static curve's top")
        ax.set_title(f"{title} · {trace['cost_bps']:.1f} bps per fill on average")
        ax.set_ylabel('Price vs arrival (%)')
        ax.set_ylim(-5.8, 9)
        ax.legend(loc='upper left', ncol=5, fontsize=8.5, frameon=True, facecolor='white', edgecolor='white', framealpha=0.92)
    axes[1].set_xlabel('Hours since the TWAP start')
    axes[1].set_xlim(0, path['hours'])
    header(
        fig,
        'One 24-hour market path: a curve anchored to the limit price against one re-anchored every part',
        f"The {int(path['percentile'] * 100)}th-percentile path of 1,000 by final price (σ {int(path['sigma'] * 100)}%/yr), {path['parts']} parts on 12 s blocks, 10 bps resolver margin. "
        "Once the market rallies past the static curve's top, every part fills at the top and the resolver keeps the difference; the ratchet follows the market.",
        f"Source: scripts/twap/simulation.py · seed {path['seed']}",
        top=0.84, bottom=0.08,
    )
    save(fig, 'twap_sim_sample_path.png')


def late_and_parameters(sim):
    fig, (ax, bx, cx) = plt.subplots(1, 3, figsize=(13.5, 5.4), gridspec_kw={'wspace': 0.28})

    late = sim['late']
    names = list(late)
    labels = ['Fixed start\n½-interval\nauction', 'Fixed start\nfull-interval\nauction', 'Start\nanchored to\nannouncement']
    xs = range(len(names))
    width = 0.38
    first = ax.bar([x - width / 2 for x in xs], [late[n]['first_fill_cost_bps'] for n in names], width, color=C['bad'], label='First fill (the backlog)')
    whole = ax.bar([x + width / 2 for x in xs], [late[n]['cost_at_fill_bps'] for n in names], width, color=C['neutral'], label='Whole order')
    ax.bar_label(first, fmt='%.0f', padding=2, fontsize=8.5)
    ax.bar_label(whole, fmt='%.0f', padding=2, fontsize=8.5)
    ax.set_xticks(list(xs), labels, fontsize=8.5)
    ax.set_ylabel('Cost per fill (bps)')
    ax.set_title('Order fillable 0–60 min after its start')
    ax.legend(loc='upper right')

    tops = sim['params']['top_premium']
    xs = range(len(tops))
    mean = bx.bar([x - width / 2 for x in xs], [t['cost_at_fill_bps'] for t in tops], width, color=C['twap'], label='Mean')
    p95 = bx.bar([x + width / 2 for x in xs], [t['cost_p95_bps'] for t in tops], width, color=C['p95'], label='95th-percentile path')
    bx.bar_label(mean, fmt='%.0f', padding=2, fontsize=8.5)
    bx.bar_label(p95, fmt='%.0f', padding=2, fontsize=8.5)
    bx.set_xticks(list(xs), [f"+{int(t['top'] * 100)}%" for t in tops])
    bx.set_xlabel("Static curve's top, above the arrival price")
    bx.set_ylabel('Cost per fill (bps)')
    bx.set_title('Starting premium (24 parts)')
    bx.legend(loc='upper center')

    intervals = sim['params']['interval']
    xs = range(len(intervals))
    static = cx.bar([x - width / 2 for x in xs], [i['static']['cost_at_fill_bps'] for i in intervals], width, color=C['static'], label='Static, +3% top')
    ratchet = cx.bar([x + width / 2 for x in xs], [i['ratchet']['cost_at_fill_bps'] for i in intervals], width, color=C['ratchet'], label='Ratchet')
    cx.bar_label(static, fmt='%.0f', padding=2, fontsize=8.5)
    cx.bar_label(ratchet, fmt='%.0f', padding=2, fontsize=8.5)
    cx.set_xticks(list(xs), [f"{i['minutes']} min\n({i['parts']} parts)" for i in intervals])
    cx.set_xlabel('Part interval')
    cx.set_ylabel('Mean cost per fill (bps)')
    cx.set_title('Part length')
    cx.legend(loc='upper left')
    header(
        fig,
        'Late starts, starting premium and part length: Monte Carlo',
        'A 4-hour TWAP on Ethereum blocks, σ 60%/yr, costs including a 10 bps resolver margin. The model has no market impact, which would favour more, smaller parts.',
        SIM_SOURCE,
        top=0.83, bottom=0.2,
    )
    save(fig, 'twap_sim_late_and_parameters.png')


def main():
    with open(os.path.join(OUT, 'onchain.json')) as f:
        onchain = json.load(f)
    with open(os.path.join(OUT, 'simulation.json')) as f:
        sim = json.load(f)
    price_curve(onchain)
    execution(onchain)
    late_start(onchain)
    gas(onchain)
    anchoring(sim)
    sample_path(sim)
    late_and_parameters(sim)


if __name__ == '__main__':
    main()
