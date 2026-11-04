module examples.struct_demo;

import examples.records::{Pair, increment};

int main() {
    Pair original = Pair{20, 20, true};
    Pair changed = increment(original);
    if (original.left != 20 || original.right != 20) return 1;
    if (changed.ready) return changed.left + changed.right;
    return 0;
}
