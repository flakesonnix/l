module examples.switch_demo;

int weekday(int day) {
    switch (day) {
        case 0:
        case 6:
            return 1;
        case 1:
        case 2:
        case 3:
        case 4:
        case 5:
            return 0;
        default:
            return -1;
    }
}

int main() {
    int workdays = 0;
    for (int day = 0; day < 7; day++) {
        switch (weekday(day)) {
            case 0:
                workdays++;
                break;
            case 1:
                break;
            default:
                break;
        }
    }
    return workdays + 37;
}
