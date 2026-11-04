module examples.alias_demo;

import examples.types::{Count, flags::Enabled};

using Value = Count;
static Value count = 40;

Value next() {
    return count++;
}

int main() {
    Enabled active = true;
    Value values[1];
    values[0] = next();
    if (active) return values[0] + next() - 39;
    return 0;
}
