#!/usr/bin/env python3
"""Docs wiring checker for the TrendPulse docs pack.

Usage: python tools/check_docs_wiring.py [docs_dir]

Checks (errors unless noted):
  1. every test ID mentioned anywhere is defined (07, 10 section 3, 11)
  2. every defined test ID is scheduled exactly once in 10 (or deferred)
  3. every task maps to tests defined and scheduled in its own or an earlier phase
  4. every health row has a gate in 10 section 5, no test is scheduled after its row's gate,
     and the cumulative row counts in 10 match
  5. every FR and US defined in 01, 08, 11 is in 10 section 9 with existing tests and existing rows
  6. phase dependencies point backward only
  7. the Day-1 board in 12 section 8 is a subset of the real rows and tests and its row count is right
  8. (warning) stale totals such as 40/40, 46/46, 54/54, 60/60 in non-history text
"""
import re, sys, pathlib

D = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path(__file__).resolve().parent.parent
PREFIXES = "SET COL NRM LLM SHT SRT RUN API UI SEC NFR PKG PRF FBK GEN ANG IDEA DIG SCR INF W CH JEV STY DEC".split()
ID_RE = re.compile(r'\b(' + '|'.join(sorted(PREFIXES, key=len, reverse=True)) + r')-(\d{2})((?:\s*(?:…|,)\s*\d{2}(?!\d))*)')
ROW_RE = re.compile(r'\b([FSJUD])(\d{2})\b')

errors, warnings = [], []
def err(m): errors.append(m)
def warn(m): warnings.append(m)

def text(name):
    p = D / name
    if not p.exists():
        err(f"missing file {name}"); return ""
    return p.read_text(encoding='utf-8')

def ids_in(t):
    out = []
    for m in ID_RE.finditer(t):
        pre, n0, tail = m.group(1), int(m.group(2)), m.group(3)
        nums, last = [n0], n0
        for tm in re.finditer(r'(…|,)\s*(\d{2})', tail):
            sep, n = tm.group(1), int(tm.group(2))
            nums.extend(range(last + 1, n + 1) if sep == '…' else [n])
            last = n
        out += [f"{pre}-{i:02d}" for i in nums]
    return out

def rows_in(t):
    """Expand health row tokens like F03…F09, S05, S06 into a list."""
    out, t = [], t.replace('...', '…')
    for m in re.finditer(r'\b([FSJUD])(\d{2})(?:\s*…\s*[FSJUD]?(\d{2}))?', t):
        L, a, b = m.group(1), int(m.group(2)), m.group(3)
        out += [f"{L}{i:02d}" for i in range(a, int(b) + 1)] if b else [f"{L}{a:02d}"]
    return out

files = sorted(p.name for p in D.glob('*.md'))
alltext = {n: text(n) for n in files}

# ---- definitions ----
defined, first_def = set(), {}
def_pat = re.compile(r'^\|\s*((?:' + '|'.join(PREFIXES) + r')-\d{2})\s*\|', re.M)
bul_pat = re.compile(r'^- \*\*((?:' + '|'.join(PREFIXES) + r')-\d{2})\*\*', re.M)
for n in ('07_TESTING_PLAN.md', '10_MASTER_PLAN.md', '11_DECODE_REWIRE_AND_UI.md'):
    for m in list(def_pat.finditer(alltext.get(n, ''))) + list(bul_pat.finditer(alltext.get(n, ''))):
        i = m.group(1)
        if i in defined and first_def[i] != n:
            warn(f"{i} defined in both {first_def[i]} and {n}")
        defined.add(i); first_def.setdefault(i, n)

# ---- check 1: referenced ids exist ----
for n, t in alltext.items():
    missing = sorted({i for i in ids_in(t) if i not in defined})
    if missing:
        err(f"{n}: references undefined test IDs: {', '.join(missing[:12])}{' …' if len(missing) > 12 else ''}")

# ---- parse master plan ----
mp = alltext.get('10_MASTER_PLAN.md', '')
phase_re = re.compile(r'^### Phase (\w+) — (.+)$', re.M)
heads = list(phase_re.finditer(mp))
order = [h.group(1) for h in heads]
idx = {p: i for i, p in enumerate(order)}
sections = {}
for i, h in enumerate(heads):
    end = heads[i + 1].start() if i + 1 < len(heads) else len(re.split(r'^## 5\. Health board schedule', mp, flags=re.M)[0])
    end = min(end, mp.find('## 5. Health board schedule') if '## 5. Health board schedule' in mp else end)
    sections[h.group(1)] = mp[h.end():end]

sched, deferred = {}, set()
for p, body in sections.items():
    for lm in re.finditer(r'^\*\*(?:Tests|Wiring tests):\*\*(.*)$', body, re.M):
        for i in ids_in(lm.group(1)):
            if i in sched and sched[i] != p:
                err(f"{i} scheduled twice ({sched[i]} and {p})")
            sched[i] = p
    for lm in re.finditer(r'^\*\*Deferred \(not scheduled\):\*\*(.*)$', body, re.M):
        deferred |= set(ids_in(lm.group(1)))
    for lm in re.finditer(r'\*\*Notes:\*\*.*?[Dd]eferred: (.*?)\.', body):
        deferred |= set(ids_in(lm.group(1)))

# ---- check 2: every defined id scheduled once ----
for i in sorted(defined):
    if i not in sched and i not in deferred:
        err(f"{i} ({first_def[i]}) is not scheduled in 10_MASTER_PLAN.md and not deferred")

# ---- check 3: tasks ----
task_re = re.compile(r'^- \[ \] (P\w+-T\d+) (.*)$', re.M)
n_tasks = 0
for p, body in sections.items():
    for m in task_re.finditer(body):
        n_tasks += 1
        tid, rest = m.group(1), m.group(2)
        if '→' not in rest:
            err(f"{tid}: task has no → tests"); continue
        tail = rest.rsplit('→', 1)[1]
        ids = ids_in(tail)
        if not ids and 'regression' not in tail:
            err(f"{tid}: no test IDs after →"); continue
        if not tid.startswith(f"P{p}-"):
            err(f"{tid}: task id does not match phase {p}")
        for i in ids:
            if i not in sched and i not in deferred:
                err(f"{tid}: test {i} is not scheduled anywhere")
            elif i in sched and idx.get(sched[i], 99) > idx[p]:
                err(f"{tid} (phase {p}) points to {i} scheduled later in phase {sched[i]}")

# ---- check 6: dependencies ----
for p, body in sections.items():
    m = re.search(r'^\*\*Depends on:\*\*(.*)$', body, re.M)
    if not m:
        err(f"phase {p}: missing Depends on"); continue
    for d in re.findall(r'\bP(\w+?)\b(?=[,\s]|$)', m.group(1)):
        if d in idx and idx[d] >= idx[p]:
            err(f"phase {p} depends on later phase P{d}")
        elif d not in idx:
            err(f"phase {p} depends on unknown phase P{d}")

# ---- health rows ----
rows_tests = {}   # row -> set of test ids (from 07)
row_re = re.compile(r'^\|\s*([FSJUD]\d{2})\s*\|(.*)$', re.M)
t07 = alltext.get('07_TESTING_PLAN.md', '')
for m in row_re.finditer(t07):
    row, rest = m.group(1), m.group(2)
    rows_tests.setdefault(row, set()).update(ids_in(rest))
gates = {}
sec5 = re.search(r'^## 5\. Health board schedule(.*?)^## 6\.', mp, re.M | re.S)
for m in re.finditer(r'^\|\s*([FSJUD]\d{2})\s*\|\s*P(\w+)\s*\|', sec5.group(1) if sec5 else '', re.M):
    gates[m.group(1)] = m.group(2)
for r in rows_tests:
    if r not in gates:
        err(f"health row {r} (07) has no gate in 10 section 5")
for r in gates:
    if r not in rows_tests:
        err(f"health row {r} (10 section 5) has no definition in 07")
for r, tests in rows_tests.items():
    g = gates.get(r)
    if not g or g not in idx:
        continue
    for i in tests:
        if i in sched and idx.get(sched[i], 99) > idx[g]:
            err(f"row {r} gates at P{g} but uses {i} scheduled later in P{sched[i]}")
# cumulative counts
m = re.search(r'^Cumulative green rows at each gate:(.*)$', mp, re.M)
if m:
    claimed = {pp: int(n) for pp, n in re.findall(r'P(\w+) (\d+)', m.group(1))}
    for pp, n in claimed.items():
        if pp not in idx:
            err(f"cumulative line references unknown phase P{pp}"); continue
        actual = sum(1 for r, g in gates.items() if g in idx and idx[g] <= idx[pp])
        if actual != n:
            err(f"cumulative rows at P{pp}: doc says {n}, computed {actual}")
else:
    err("10_MASTER_PLAN.md: no cumulative rows line")

# ---- check 5: requirements ----
reqs = {}
for n in ('01_PRD.md', '08_V1_1_OWN_CONTENT_PACK.md', '11_DECODE_REWIRE_AND_UI.md'):
    for m in re.finditer(r'^- (FR-\d+|US-\d+)[ :]', alltext.get(n, ''), re.M):
        reqs.setdefault(m.group(1), n)
sec9 = re.search(r'^## 9\. Traceability(.*?)^## 10\.', mp, re.M | re.S)
trace = {}
for m in re.finditer(r'^\|\s*((?:FR|US)-\d+)\s*\|([^|]*)\|([^|]*)\|([^|]*)\|', sec9.group(1) if sec9 else '', re.M):
    trace[m.group(1)] = (m.group(2), m.group(3), m.group(4))
for r, src in sorted(reqs.items(), key=lambda kv: (kv[0][:2], int(kv[0].split('-')[1]))):
    if r not in trace:
        err(f"{r} (defined in {src}) is missing from 10 section 9"); continue
    _, tests, hrows = trace[r]
    tid = ids_in(tests)
    if not tid:
        err(f"{r}: no tests in traceability")
    for i in tid:
        if i not in defined:
            err(f"{r}: unknown test {i}")
    for hr in rows_in(hrows):
        if hr not in gates:
            err(f"{r}: unknown health row {hr}")
for r in trace:
    if r not in reqs:
        warn(f"{r} appears in 10 section 9 but is not defined in 01, 08 or 11")

# ---- check 7: Day-1 board ----
t12 = alltext.get('12_ONE_DAY_BUILD_PROMPTS.md', '')
sec8 = re.search(r'^## 8\. Day-1 verify board \((\d+) rows\)(.*?)^\*\*Day-1 Definition', t12, re.M | re.S)
if sec8:
    claimed_n = int(sec8.group(1))
    day1 = re.findall(r'^\|\s*([FSJUD]\d{2})\s*\|[^|]*\|([^|]*)\|', sec8.group(2), re.M)
    if len(day1) != claimed_n:
        err(f"12 section 8 says {claimed_n} rows but lists {len(day1)}")
    for r, tests in day1:
        if r not in gates:
            err(f"Day-1 row {r} is not a real health row")
            continue
        extra = set(ids_in(tests)) - rows_tests.get(r, set())
        if extra:
            err(f"Day-1 row {r} requires tests not in the real row: {', '.join(sorted(extra))}")
else:
    warn("12 section 8 (Day-1 board) not found")

# ---- check 8: stale totals ----
for n, t in alltext.items():
    for stale in ('40/40', '54/54'):
        if stale in t:
            warn(f"{n}: contains stale total {stale}")

print(f"docs: {len(files)} files | tests defined: {len(defined)} | scheduled: {len(sched)} | deferred: {len(deferred)} | tasks: {n_tasks} | phases: {len(order)} | health rows: {len(gates)} | requirements: {len(reqs)}")
for w in warnings: print("WARN ", w)
for e in errors: print("ERROR", e)
print(f"\n{len(errors)} error(s), {len(warnings)} warning(s)")
sys.exit(1 if errors else 0)
