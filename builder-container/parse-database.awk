BEGINFILE {
    filename=""
    name=""
    base=""
}
/%FILENAME%/ {
    v=1
    next
}
/%NAME%/ {
    v=2
    next
}
/%BASE%/ {
    v=3
    next
}
v==1 {
    filename=$0
    v=0
}
v==2 {
    name=$0
    v=0
}
v==3 {
    base=$0
    v=0
}
ENDFILE {
    print filename, name, base
}