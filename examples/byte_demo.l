module examples.byte_demo;

import examples.byte_values::{Octet, Pair, sum};

const Octet initial = byte(20);
static byte current = initial;

int main() {
    byte data[2];
    data[0] = current;
    data[1] = byte(22);
    current = sum(Pair{data[0], data[1]});
    switch (current) {
        case byte(42): return int(current);
        default: return 0;
    }
}
