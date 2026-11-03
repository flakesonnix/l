module examples.arrays;

int main() {
    int squares[5];
    for (int i = 0; i < 5; i++) {
        squares[i] = i * i;
    }

    int sum = 0;
    for (int i = 0; i < 5; i++) {
        sum = sum + squares[i];
    }
    return sum + 12;
}
