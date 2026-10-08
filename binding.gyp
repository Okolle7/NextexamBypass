{
  "targets": [{
    "target_name": "keyboardhook",
    "sources": ["native/keyboardhook.cc"],
    "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
    "dependencies": ["<!(node -p \"require('node-addon-api').gyp\")"],
    "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
    "libraries": ["user32.lib"]
  }]
}