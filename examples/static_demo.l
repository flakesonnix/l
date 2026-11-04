module examples.static_demo;

import examples.state::{next, flags::enabled};

int main() {
    if (enabled) return next() + next() - 39;
    return 0;
}
