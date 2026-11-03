module examples.answer;

int triangular(int limit) {
    int sum = 0;
    for (int i = 0; i <= limit; i++) {
        sum = sum + i;
    }
    return sum;
}

int main() {
    const int answer = triangular(8) + 6;
    return answer;
}
