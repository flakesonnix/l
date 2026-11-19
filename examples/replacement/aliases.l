module app.aliases;

pub Count = alias Value;
Value = alias int;
Flag = alias bool;

answer: Count = 42;
ready: Flag = answer == 42;

Count identity(const Count value) { return value; }
int main() {
    return if ready then (let value: Count = identity(answer); in value) else 0;
}
