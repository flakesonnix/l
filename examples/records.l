module examples.records;

pub struct Pair {
    int left;
    int right;
    bool ready;
};

pub Pair increment(Pair value) {
    value.left++;
    value.right++;
    return value;
}
