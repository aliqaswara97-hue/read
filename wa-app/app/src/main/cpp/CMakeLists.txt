cmake_minimum_required(VERSION 3.18.1)
project("native-lib")
add_library(node SHARED IMPORTED)
set_target_properties(node PROPERTIES IMPORTED_LOCATION
    ${CMAKE_CURRENT_SOURCE_DIR}/../../../libnode/bin/${ANDROID_ABI}/libnode.so)
include_directories(${CMAKE_CURRENT_SOURCE_DIR}/../../../libnode/include/node)
add_library(native-lib SHARED native-lib.cpp)
target_link_libraries(native-lib node log)
