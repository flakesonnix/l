#include "../bootstrap/stage0/l.h"

#include <stdlib.h>
#include <string.h>

static int check(const char *source, bool valid) {
    Context *ctx = calloc(1, sizeof(*ctx));
    if (!ctx) exit(1);
    ctx->filename = "frontend-test.l";
    if (!setjmp(ctx->failure)) {
        size_t count;
        Token *tokens = lex(ctx, source, strlen(source), &count);
        analyze(ctx, parse(ctx, tokens, count));
    }
    bool accepted = ctx->status == 0;
    cleanup(ctx);
    free(ctx);
    if (accepted == valid) return 0;
    fprintf(stderr, "unexpected %s: %s\n", accepted ? "acceptance" : "rejection", source);
    return 1;
}

int main(void) {
    static const struct { const char *source; bool valid; } cases[] = {
        {"int main() { return 0; }", true},
        {"module app.main; /* comment */ int main(){ auto n=40; const int m=2; return n+m; }", true},
        {"int main(){return add(20,22);} int add(int a,int b){return a+b;}", true},
        {"bool positive(int a){return a>0;} int main(){if(positive(1))return 42;else return 0;}", true},
        {"int main(){int n=0;for(int i=0;i<7;i++){n=n+i;}while(n<42)n++;return n;}", true},
        {"void f(){return;} int main(){f();return 0;}", true},
        {"int main(){int n=1;{int n=2;n++;}return n;}", true},
        {"int main(){return -2147483648;}", true},
        {"int main(){bool b=true&&false||!false; if(b)return 1;return 0;}", true},
        {"int main(){return 2147483648;}", false},
        {"int main(){return 999999999999999999999999999;}", false},
        {"int main(){return true;}", false},
        {"int main(){int n;return n;}", false},
        {"int main(){const int n=1;n++;return n;}", false},
        {"int main(){const int n=1;n=2;return n;}", false},
        {"int main(){auto n=true;n=1;return 0;}", false},
        {"int main(){if(1)return 0;return 1;}", false},
        {"int main(){if(true)return 0;}", false},
        {"int main(){return missing;}", false},
        {"int main(){return missing();}", false},
        {"int f(int n){return n;}int main(){return f();}", false},
        {"int f(bool n){return 0;}int main(){return f(1);}", false},
        {"int main(){int x=0;int x=1;return x;}", false},
        {"int f(int n){int n=0;return n;}int main(){return 0;}", false},
        {"int main(){for(int i=0;i<1;i++){}return i;}", false},
        {"int main(){if(true)int n=1;return n;}", false},
        {"int main(){auto n=n;return n;}", false},
        {"int main(){return true+false;}", false},
        {"void f(){}int main(){auto n=f();return 0;}", false},
        {"void f(){}int main(){return f()==f();}", false},
        {"int main(){int f=1;return f();}", false},
        {"int main(){return 0;}int main(){return 1;}", false},
        {"int main(int argc){return argc;}", false},
        {"void main(){}", false},
        {"auto main(){return 0;}", false},
        {"int f(void n){return 0;}int main(){return 0;}", false},
        {"int f(){return 0;}", false},
        {"int main(){return 0", false},
        {"int main(){/* unterminated", false},
        {"int main(){return 42oops;}", false},
        {"int main(){return @;}", false}
    };
    int failures = 0;
    for (size_t i = 0; i < sizeof(cases) / sizeof(*cases); ++i) failures += check(cases[i].source, cases[i].valid);
    if (!failures) puts("frontend: 41 cases passed");
    return failures != 0;
}
