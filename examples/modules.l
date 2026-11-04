module examples.modules;

import examples.math as math;
import examples.math::{numbers::answer as answer};

int main() {
    return math::numbers::answer(10) + answer(true) - 20;
}
