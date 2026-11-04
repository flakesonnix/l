module examples.loop_control;

int main() {
    int sum = 0;
    for (int i = 0; i < 10; i++) {
        if (i == 7) {
            break;
        }
        if (i % 2 == 0) {
            continue;
        }
        sum = sum + i;
    }
    return sum + 33;
}
