#!/bin/sh
set -eu
compiler=$(realpath "$1")
root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
mkdir -p "$root/build"
work=$(mktemp -d "$root/build/test.XXXXXX")
trap 'rm -rf -- "$work"' EXIT HUP INT TERM
count=0
cat >"$work/package.json" <<EOF
{"version":1,"package":"test","module_roots":[{"package":"test","prefix":"","path":"."},{"package":"test","prefix":"examples","path":"$root/examples"}],"dependencies":[]}
EOF
source_compiler() { "$compiler" "$@" --manifest "$work/package.json"; }

status() {
    want_status=$1
    shift
    actual=0
    "$@" >"$work/stdout" 2>"$work/stderr" || actual=$?
    if [ "$actual" -ne "$want_status" ]; then
        cat "$work/stderr" >&2
        echo "FAIL: expected exit $want_status, got $actual: $*" >&2
        exit 1
    fi
    count=$((count + 1))
}

program() {
    program_status=$1
    source=$2
    program_error=${3:-'VM trap:'}
    printf 'module input;\n%s\n' "$source" >"$work/input.l"
    status 0 source_compiler check "$work/input.l"
    status "$program_status" source_compiler run "$work/input.l"
    if [ "$program_status" -eq 70 ]; then grep -Fq "$program_error" "$work/stderr"; fi
    status 0 source_compiler compile "$work/input.l" -o "$work/first.lbc"
    status 0 "$compiler" check "$work/first.lbc"
    status "$program_status" "$compiler" run "$work/first.lbc"
    if [ "$program_status" -eq 70 ]; then grep -Fq "$program_error" "$work/stderr"; fi
    status 0 source_compiler inspect "$work/input.l"
    cp "$work/stdout" "$work/source.ir"
    status 0 "$compiler" inspect "$work/first.lbc"
    cmp "$work/source.ir" "$work/stdout"
    status 0 source_compiler compile "$work/input.l" -o "$work/second.lbc"
    cmp "$work/first.lbc" "$work/second.lbc"
}

program 42 'int main(){return 6*7;}'
program 55 'int fib(int n){if(n<2)return n;return fib(n-1)+fib(n-2);} int main(){return fib(10);}'
program 42 'int main(){int n=0;for(int i=0;i<7;i++){n=n+i;}while(n<42)n++;return n;}'
program 42 'int sum(int a,int b){return a+b;}int main(){return sum(sum(10,10),sum(10,12));}'
program 7 'int main(){int n=7;{int n=100;n++;}return n;}'
program 0 'int main(){int n=0;bool b=false&&((n=1)==1);bool c=true||((n=2)==2);return n;}'
program 2 'int main(){int n=0;bool b=true&&((n=1)==1);bool c=false||((n=2)==2);return n;}'
program 42 'void nop(){}void done(){return;} int main(){nop();done();auto n=40;n++;n++;return n;}'
program 42 'int main(){int x=0;int y=0;x=y=42;return +x;}'
program 1 'int main(){if(!false&&true!=false&&1==1&&1<=2&&2>=1&&2>1)return 1;else return 2;}'
program 42 'int main(){int n=43;int old=n--;if(old!=43)return 1;return n;}'
program 42 'int main(){for(;;){return 42;}return 0;}'
program 42 'int main(){int n=0;for(n=40;n<42;){n++;}return n;}'
program 42 'int main(){if(false){return 0;}else{int x=1;}return 42;}'
program 42 'int main(){if(true){int x=1;}else{return 0;}return 42;}'
program 42 'int main(){if(false){return 0;}return 42;}'
program 0 'int main(){return -2147483648%3+2;}'
program 0 'int main(){return 2147483647-2147483647;}'
program 0 'int main(){;return 7/2-3;}'
program 70 'int main(){return 2147483647+1;}'
program 70 'int main(){return -2147483648-1;}'
program 70 'int main(){return 100000*100000;}'
program 70 'int main(){return -(-2147483648);}'
program 70 'int main(){return 1/0;}'
program 70 'int main(){return 1%0;}'
program 70 'int main(){return -2147483648/-1;}'
program 70 'int main(){return -2147483648%-1;}'
program 70 'int recurse(){return recurse();}int main(){return recurse();}'
program 70 'int main(){while(true){}return 0;}'

program 42 'int main(){int a[3];a[0]=40;a[2]=2;return a[0]+a[1]+a[2];}'
program 0 'int main(){int a[65535];int b[1];return a[65534]+b[0];}'
program 42 'int main(){bool b[2];b[1]=true;if(!b[0]&&b[1])return 42;return 0;}'
program 42 'int main(){int a[5];for(int i=0;i<5;i++)a[i]=i*i;int sum=0;for(int i=0;i<5;i++)sum=sum+a[i];return sum+12;}'
program 42 'int main(){int a[2];int i=0;a[i++]=40;int old=a[0]++;a[0]--;return old+i+1;}'
program 42 'int main(){int a[2];int i=0;a[i++]=i;int old=a[i++]++;return a[0]+old+i+39;}'
program 42 'int main(){int a[2];a[0]=a[1]=21;return a[0]+a[1];}'
program 42 'int main(){int a[2];int b[1];b[0]=1;a[b[0]]=42;return a[b[0]];}'
program 0 'int main(){for(int i=0;i<2;i++){int a[1];if(a[0]!=0)return 1;a[0]=42;}return 0;}'
program 42 'int f(int n){int a[1];a[0]=n;if(n>0)return a[0]+f(n-1);return 0;}int main(){return f(6)*2;}'
program 0 'int main(){const int a[1];{int a[1];a[0]=42;}return a[0];}'
program 70 'int main(){int a[3];return a[3];}' 'array index out of bounds'
program 70 'int main(){int a[3];return a[-1];}' 'array index out of bounds'
program 70 'int main(){int a[3];a[3]=1;return 0;}' 'array index out of bounds'
program 70 'int main(){int a[3];a[-1]=1;return 0;}' 'array index out of bounds'
program 70 'int main(){int a[3];a[3]++;return 0;}' 'array index out of bounds'
program 70 'int main(){int a[1];a[1]=1/0;return 0;}' 'array index out of bounds'
program 70 'int main(){int a[1];a[0]=2147483647;a[0]++;return 0;}' 'integer overflow'
program 70 'int main(){int a[1];a[0]=-2147483648;a[0]--;return 0;}' 'integer overflow'

program 42 'int main(){int n=0;int sum=0;while(true){n++;if(n==7)break;sum=sum+n;}return sum*2;}'
program 42 'int main(){int n=0;int sum=0;while(n<8){n++;if(n%2==1)continue;sum=sum+n;}return sum+22;}'
program 42 'int main(){int sum=0;for(int i=0;i<10;i++){if(i<2)continue;if(i>4)continue;sum=sum+i;}return sum+33;}'
program 42 'int main(){int sum=0;for(int i=0;i<10;i++){if(i==3)break;if(i>5)break;sum=sum+i;}return sum+39;}'
program 42 'int main(){int sum=0;for(int i=0;i<10;i++){if(i==7)break;if(i==3)break;sum=sum+i;}return sum+39;}'
program 42 'int main(){int n=0;for(int i=0;i<5;i++){if(i==3)break;for(int j=0;j<5;j++){if(j==1)continue;if(j==4)break;n++;}}return n+33;}'
program 42 'int main(){for(int i=0;i<3;i++){while(true)break;continue;1/0;}return 42;}'
program 42 'int main(){int n=0;int sum=0;while(n<3){n++;int i=0;while(true){i++;if(i==2)continue;if(i==4)break;sum++;}if(n<3)continue;break;}return sum+36;}'
program 42 'int main(){for(;;1/0){break;}return 42;}'
program 42 'int main(){for(;;1/0){return 42;}return 0;}'
program 42 'int main(){int n=0;for(;n<3;){n++;continue;}return n+39;}'
program 42 'int main(){int n=0;for(;;n++){if(n<3)continue;else break;}return n+39;}'
program 42 'int main(){for(int i=0;i<3;i++)continue;return 42;}'
program 42 'int main(){int n=0;while((n=n+1)<3)continue;return n+39;}'
program 42 'int main(){int sum=0;for(int i=0;i<3;i++){int a[1];if(a[0]!=0)return 1;a[0]=i;if(i<2)continue;sum=sum+a[0];}return sum+40;}'
program 42 'void f(){for(;;){break;}}int main(){f();return 42;}'
program 70 'int main(){while(true)continue;return 0;}' 'instruction limit exceeded'
program 70 'int main(){for(;;1/0)continue;return 0;}' 'division by zero'

program 42 'int pick(int n){switch(n){case 0:return 10;case 1:return 20;case 2:case 3:return 30;default:return 99;}}int main(){return pick(0)+pick(1)+pick(2)+pick(3)+pick(4)-147;}'
program 42 'int main(){int n=0;switch(5){case 1:n=1;break;default:n=2;}return n+40;}'
program 42 'int main(){int n=0;switch(2){case 1:n=1;case 2:n=2;case 3:n=n+1;}return n+39;}'
program 42 'int main(){switch(9){}return 42;}'
program 42 'int main(){int n=1;switch(n){case 1:n=41;}return n+1;}'
program 42 'int main(){int n=0;switch(-1){case -1:n=20;break;default:n=1;}return n+22;}'
program 42 'int main(){int n=0;switch(2147483647){case 2147483647:n=40;break;}return n+2;}'
program 42 'int main(){int n=0;switch(-2147483648){case -2147483648:n=40;break;}return n+2;}'
program 42 'int f(int n){switch(n){case 1:return 1;default:return 0;}}int main(){return f(1)*42;}'
program 42 'int f(int n){switch(n){case 1:return 1;default:return 0;}}int main(){return f(9)+42;}'
program 42 'int f(int n){switch(n){case 1:break;default:return 1;}return 0;}int main(){return f(1)+42;}'
program 42 'int f(int n){switch(n){case 1:break;default:return 1;}return 0;}int main(){return f(9)+41;}'
program 42 'int main(){int n=0;while(true){switch(n){case 3:break;default:n++;continue;}break;}return n+39;}'
program 42 'int main(){int total=0;for(int i=0;i<4;i++){switch(i){case 0:total=total+1;continue;case 1:total=total+10;break;default:total=total+100;break;}}return total-169;}'
program 42 'int main(){switch(2){case 1:{int x=1;return x;}case 2:{int x=42;return x;}default:return 0;}}'
program 42 'int main(){int a[3];a[0]=2;switch(a[0]){case 2:a[1]=42;break;default:return 0;}return a[1];}'
program 42 'int main(){switch(1+1){case 2:return 42;default:return 0;}}'
program 42 'int main(){int n=0;for(;;){switch(n){case 2:return 42;}n++;}return 0;}'
program 70 'int main(){while(true){switch(1){case 1:continue;case 2:return 0;}return 0;}return 0;}' 'instruction limit exceeded'
program 70 'int main(){int n=0;switch(n){case 0:1/0;default:break;}return 42;}' 'division by zero'
program 42 'int main(){switch(1){default:return 42;break;int n=1;}}'
program 42 'int main(){switch(1){default:return 42;{break;int n=1;}}}'
program 42 'int main(){switch(1){case 1:return 42;1/0;default:return 0;}}'
program 42 'int main(){int n=0;switch(1){case 1:n=42;break;n=0;default:return 0;}return n;}'
program 42 'int main(){switch(3){default:case 0:case 1:return 42;}}'
program 42 'int main(){int n=0;switch(2){default:n=1;case 2:n=n+41;}return n+1;}'
program 42 'int main(){switch(1){default:while(true){break;}return 42;}}'
program 42 'int main(){switch(1){default:for(;;){break;}return 42;}}'
program 42 'int main(){int n=0;for(int i=0;i<3;i++){switch(i){default:switch(i){default:continue;}}n=1;}return n+42;}'
program 42 'int main(){int n=0;switch(0){default:switch(1){case 1:break;default:return 0;}n=42;break;}return n;}'
program 42 'int main(){switch(0){default:if(true)return 42;else return 0;}}'
program 42 'int main(){switch(0){default:if(false)break;else return 42;}return 0;}'
program 42 'int main(){int a[1];a[0]=2;int index=0;int n=0;switch(a[index++]){case 2:n=41;break;default:return 0;}return n+index;}'
program 42 'int main(){switch(2){case 1:int n=7;case 2:n=42;return n;default:return 0;}}'

status 42 source_compiler run "$root/examples/answer.l"
status 55 source_compiler run "$root/examples/fibonacci.l"
status 42 source_compiler run "$root/examples/arrays.l"
status 42 source_compiler run "$root/examples/loop_control.l"
status 42 source_compiler run "$root/examples/switch_demo.l"
status 42 source_compiler run "$root/examples/modules.l"
status 42 source_compiler run "$root/examples/constants.l"
status 42 source_compiler run "$root/examples/static_demo.l"
status 64 "$compiler"
status 64 "$compiler" unknown ignored
status 64 "$compiler" compile ignored
status 64 "$compiler" compile ignored --output ignored
status 64 "$compiler" compile ignored -o ignored
status 64 "$compiler" check ignored extra
status 74 "$compiler" check "$work/missing.l"
printf 'module bad;\nint main(){return true;}\n' >"$work/bad.l"
status 65 source_compiler check "$work/bad.l"
grep -q ':2:12: error: expected int, got bool' "$work/stderr"
status 65 source_compiler compile "$work/bad.l" -o "$work/invalid.lbc"
test ! -e "$work/invalid.lbc"
printf 'module bad;\nint main(){break;return 0;}\n' >"$work/bad.l"
status 65 source_compiler check "$work/bad.l"
grep -Fq ':2:12: error: break requires an enclosing loop' "$work/stderr"
printf 'module bad;\nint main(){continue;return 0;}\n' >"$work/bad.l"
status 65 source_compiler check "$work/bad.l"
grep -Fq ':2:12: error: continue requires an enclosing loop' "$work/stderr"
printf 'module bad;\nint main(){switch(2){case 1:int n=42;case 2:return n;default:return 0;}}\n' >"$work/bad.l"
status 65 source_compiler check "$work/bad.l"
grep -Fq 'slot is uninitialized' "$work/stderr"
printf 'module bad;\nint main(){switch(2){case 1:int a[1];case 2:return a[0];default:return 0;}}\n' >"$work/bad.l"
status 65 source_compiler check "$work/bad.l"
grep -Fq 'slot is uninitialized' "$work/stderr"
printf 'module bad;\nint main(){switch(2){case 1:int n=42;case 2:n++;return n;default:return 0;}}\n' >"$work/bad.l"
status 65 source_compiler check "$work/bad.l"
grep -Fq 'slot is uninitialized' "$work/stderr"
printf 'module bad;\nint main(){switch(2){case 1:int a[1];case 2:a[0]=42;return a[0];default:return 0;}}\n' >"$work/bad.l"
status 65 source_compiler check "$work/bad.l"
grep -Fq 'slot is uninitialized' "$work/stderr"
status 65 "$compiler" compile "$work/first.lbc" -o "$work/no.lbc"
status 74 source_compiler compile "$root/examples/answer.l" -o "$work/missing/out.lbc"
status 74 source_compiler compile "$root/examples/answer.l" -o /dev/full
printf 'nope' >"$work/bad.lbc"
status 65 "$compiler" run "$work/bad.lbc"

# Exercise format sniffing independently of file suffix and file length.
cp "$work/first.lbc" "$work/bytecode.data"
status 0 "$compiler" check "$work/bytecode.data"
printf '' >"$work/empty.l"
status 65 "$compiler" check "$work/empty.l"
status 74 "$compiler" check x
# A successful load through a name shorter than four characters.
status 0 source_compiler compile "$root/examples/answer.l" -o "$work/answer.lbc"
cp "$work/answer.lbc" "$work/b"
status 42 sh -c 'cd "$1"; exec "$2" run b' sh "$work" "$compiler"
printf 'LBC\000\002\000\000\000' >"$work/bad.lbc"
status 65 "$compiler" run "$work/bad.lbc"
printf 'LBC\000' >"$work/bad.lbc"
status 65 "$compiler" run "$work/bad.lbc"

# The same declared source bytes at different absolute paths must produce identical artifacts.
mkdir "$work/relocated"
cp "$root/examples/answer.l" "$work/relocated/answer.l"
printf '{"version":1,"package":"test","module_roots":[{"package":"test","prefix":"examples","path":"."}],"dependencies":[]}' >"$work/relocated/package.json"
status 0 source_compiler compile "$root/examples/answer.l" -o "$work/original.lbc"
status 0 "$compiler" compile "$work/relocated/answer.l" --manifest "$work/relocated/package.json" -o "$work/relocated.lbc"
cmp "$work/original.lbc" "$work/relocated.lbc"
echo "integration: $count checks passed"
