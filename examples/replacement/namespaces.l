module app.namespaces;

math = namespace {
    pub Count = alias int;
    pub answer: Count = base + 2;
    base: Count = 40;
};

math = namespace {
    pub Count identity(const Count value) { return value; }
};

int main() {
    return let value: math::Count = math::identity(math::answer); in value;
}
