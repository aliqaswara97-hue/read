#include <jni.h>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <unistd.h>
#include "node.h"

extern "C" JNIEXPORT jint JNICALL
Java_com_waarchiver_NodeService_startNode(JNIEnv *env, jclass, jobjectArray arguments, jstring logPath) {
    const char *lp = env->GetStringUTFChars(logPath, nullptr);
    int fd = open(lp, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    env->ReleaseStringUTFChars(logPath, lp);
    if (fd >= 0) { dup2(fd, 1); dup2(fd, 2); }

    int argc = env->GetArrayLength(arguments);
    int total = 0;
    for (int i = 0; i < argc; i++) {
        jstring s = (jstring) env->GetObjectArrayElement(arguments, i);
        total += env->GetStringUTFLength(s) + 1;
        env->DeleteLocalRef(s);
    }
    // node/libuv requires argv strings in one contiguous block
    char *buf = (char *) calloc(total, 1);
    char **argv = (char **) malloc(sizeof(char *) * argc);
    char *cur = buf;
    for (int i = 0; i < argc; i++) {
        jstring s = (jstring) env->GetObjectArrayElement(arguments, i);
        const char *u = env->GetStringUTFChars(s, nullptr);
        size_t n = strlen(u);
        memcpy(cur, u, n);
        argv[i] = cur;
        cur += n + 1;
        env->ReleaseStringUTFChars(s, u);
        env->DeleteLocalRef(s);
    }
    return node::Start(argc, argv);
}
