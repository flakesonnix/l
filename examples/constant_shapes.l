module examples.constant_shapes;

import examples.values::{numbers::answer};

const int width = answer / 14;

int main() {
    int values[(width + 1) - 1];
    values[width - 1] = answer;
    switch (values[width - 1]) {
        case answer - 1:
            return 0;
        case answer:
            return values[width - 1];
        default:
            return 0;
    }
}
