module examples.constants;

import examples.values::{numbers::answer, numbers::ready};

int main() {
    if (ready) return answer;
    return 0;
}
