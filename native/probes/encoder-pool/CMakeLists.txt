cmake_minimum_required(VERSION 3.20)
project(screener_encoder_pool_probe LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_MSVC_RUNTIME_LIBRARY MultiThreaded)
set(WEBRTC_SDK "" CACHE PATH "Extracted matching Shiguredo WebRTC SDK")
set(MSVC_CRT_DIR "" CACHE PATH "Optional newer official MSVC x64 library directory")
if(NOT EXISTS "${WEBRTC_SDK}/lib/webrtc.lib")
  message(FATAL_ERROR "This Windows probe needs WEBRTC_SDK pointing to the matching SDK")
endif()
add_executable(encoder-pool-probe harness.cpp h264_encoder_adapter.cpp
  ../../capture/windows/h264_encoder.cpp)
target_include_directories(encoder-pool-probe SYSTEM PRIVATE
  "${WEBRTC_SDK}/include"
  "${WEBRTC_SDK}/include/third_party/abseil-cpp"
  "${WEBRTC_SDK}/include/third_party/boringssl/src/include"
  "${WEBRTC_SDK}/include/third_party/libyuv/include"
  "${WEBRTC_SDK}/include/third_party/libvpx/source/libvpx")
target_compile_definitions(encoder-pool-probe PRIVATE
  NDEBUG _ITERATOR_DEBUG_LEVEL=0 WEBRTC_WIN RTC_ENABLE_H265 NOMINMAX WIN32_LEAN_AND_MEAN _WIN32_WINNT=0x0A00)
target_compile_options(encoder-pool-probe PRIVATE /EHsc /GR /O2 /W3)
if(MSVC_CRT_DIR)
  target_link_directories(encoder-pool-probe BEFORE PRIVATE "${MSVC_CRT_DIR}")
endif()
target_link_libraries(encoder-pool-probe PRIVATE
  "${WEBRTC_SDK}/lib/webrtc.lib"
  winmm ws2_32 Strmiids crypt32 dmoguids iphlpapi msdmo Secur32 wmcodecdspuuid
  ole32 oleaut32 mfplat mf mfuuid d3d11 dxgi dxguid evr)
