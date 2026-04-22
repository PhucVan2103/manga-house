#!/bin/bash

# Thiết lập tên các file
OUTPUT_DIR="dist"
OUTPUT_FILE="final-app.zip"

echo "--- BẮT ĐẦU QUY TRÌNH BUILD & DEPLOY ---"

# 1. Tạo thư mục dist nếu chưa có
mkdir -p $OUTPUT_DIR

# 2. Chạy esbuild
echo "Đang đóng gói code với esbuild..."
npx esbuild server.js \
  --bundle \
  --platform=node \
  --target=node14 \
  --external:google-auth-library \
  --external:googleapis \
  --outfile=$OUTPUT_DIR/bundle.js

if [ $? -ne 0 ]; then
    echo "Lỗi khi build esbuild! Dừng lại."
    exit 1
fi

# 3. Nén các file cần thiết
echo "Đang nén các file..."
zip -r $OUTPUT_FILE $OUTPUT_DIR/bundle.js public/ credentials.json package.json

echo "--- THÀNH CÔNG ---"
echo "File $OUTPUT_FILE đã sẵn sàng để chuyển sang iPhone!"