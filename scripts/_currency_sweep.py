import re, io, os

files = [
  "src/app/(dashboard)/customers/[id]/customer-detail-client.tsx",
  "src/app/(dashboard)/customers/customers-client.tsx",
  "src/app/(dashboard)/sales/[id]/sale-detail-client.tsx",
  "src/app/(dashboard)/sales/sales-client.tsx",
  "src/app/(dashboard)/returns/[id]/return-detail-client.tsx",
  "src/app/(dashboard)/returns/returns-client.tsx",
  "src/app/(dashboard)/returns/new/new-return-client.tsx",
  "src/app/(dashboard)/products/products-client.tsx",
  "src/app/(dashboard)/purchases/purchases-client.tsx",
]

pat1 = re.compile(r'\$\$\{([^{}]*?)\.toFixed\(2\)\}')          # literal $ + interpolation
pat2 = re.compile(r'\$\{([^{}]*?)\.toFixed\(2\)\}')             # $ {expr} in JSX text OR interpolation

total = 0
for p in files:
    src = io.open(p, encoding="utf-8").read()
    lines = src.split("\n")
    changed = 0
    for idx, line in enumerate(lines):
        orig = line
        line = pat1.sub(lambda m: "${money(%s)}" % m.group(1), line)
        has_tick = "`" in line
        if has_tick:
            line = pat2.sub(lambda m: "${money(%s)}" % m.group(1), line)
        else:
            line = pat2.sub(lambda m: "{money(%s)}" % m.group(1), line)
        if line != orig:
            lines[idx] = line
            changed += 1
    out = "\n".join(lines)
    if 'from "@/lib/currency"' not in out:
        # insert import after the first import line
        out2 = re.sub(r'(^import [^\n]+\n)', r'\1import { money } from "@/lib/currency";\n', out, count=1, flags=re.M)
        if out2 == out:
            # no import found at top; prepend after "use client"
            out2 = out.replace('"use client";', '"use client";\n\nimport { money } from "@/lib/currency";', 1)
        out = out2
    if out != src:
        io.open(p, "w", encoding="utf-8", newline="\n").write(out)
    print(f"{p}: {changed} lines changed, import={'yes' if 'from \"@/lib/currency\"' in out else 'no'}")
    total += changed
print("TOTAL lines:", total)
