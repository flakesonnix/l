module examples.math;

int scale(int n) {
    return n * 2;
}

namespace numbers {
    pub int answer(int n) {
        return scale(n);
    }
}

namespace numbers {
    pub int answer(bool enabled) {
        if (enabled) return answer(21);
        return 0;
    }
}
