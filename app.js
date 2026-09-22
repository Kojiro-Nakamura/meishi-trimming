document.addEventListener('DOMContentLoaded', () => {
    const initialView = document.getElementById('initial-view');
    const editorView = document.getElementById('editor-view');
    const imageInput = document.getElementById('image-input');
    const canvas = document.getElementById('editor-canvas');
    const ctx = canvas.getContext('2d');
    
    const saveBtn = document.getElementById('save-btn');
    const cancelBtn = document.getElementById('cancel-btn');
    const rotateLeftBtn = document.getElementById('rotate-left');
    const rotateRightBtn = document.getElementById('rotate-right');
    
    const resultView = document.getElementById('result-view');
    const croppedResultImg = document.getElementById('cropped-result');
    const downloadBtn = document.getElementById('download-btn');
    const backToEditBtn = document.getElementById('back-to-edit-btn');
    const startOverBtn = document.getElementById('start-over-btn');
    
    let originalFileName = 'business_card.jpg';
    let currentDataUrl = null;
    let sourceImage = new Image();
    let fullResBitmap = null; // 高解像度ピクセルを保持

    // Editor state
    let points = []; // [{x, y}] in image coordinates
    let draggingPointIndex = -1;
    let displayScale = 1;
    let offsetX = 0;
    let offsetY = 0;

    // ファイル選択
    imageInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        originalFileName = file.name || 'business_card.jpg';
        
        try {
            if (window.createImageBitmap) {
                if (fullResBitmap) fullResBitmap.close && fullResBitmap.close();
                fullResBitmap = await createImageBitmap(file);
            }
        } catch(err) {
            console.error("createImageBitmap failed", err);
        }

        // メモリ不足によるSafariのリロードを防ぐため、FileReaderではなくObjectURLを使用
        const objectUrl = URL.createObjectURL(file);
        loadImage(objectUrl);
    });

    function sortPoints(pts) {
        const sum = pts.map(p => p.x + p.y);
        const diff = pts.map(p => p.x - p.y);
        
        const tl = pts[sum.indexOf(Math.min(...sum))];
        const br = pts[sum.indexOf(Math.max(...sum))];
        const tr = pts[diff.indexOf(Math.max(...diff))];
        const bl = pts[diff.indexOf(Math.min(...diff))];
        
        return [tl, tr, br, bl];
    }

    let debugTimeout = null;
    function logDebug(msg) {
        const el = document.getElementById('debug-status');
        if (el) {
            el.innerText = msg;
            el.style.opacity = '1';
            el.style.transition = 'none';
            if (debugTimeout) clearTimeout(debugTimeout);
            debugTimeout = setTimeout(() => {
                el.style.transition = 'opacity 1.5s ease-out';
                el.style.opacity = '0';
            }, 2500); // 2.5秒表示してフェードアウト
        }
        console.log(msg);
    }

    function detectDocument(imgElement) {
        try {
            logDebug("Start Pure JS detection...");
            const maxDim = 400; // 処理速度優先で小さめにリサイズ
            let scale = 1.0;
            if (imgElement.width > maxDim || imgElement.height > maxDim) {
                scale = maxDim / Math.max(imgElement.width, imgElement.height);
            }
            
            const w = Math.round(imgElement.width * scale);
            const h = Math.round(imgElement.height * scale);
            
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = w;
            tempCanvas.height = h;
            const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
            tempCtx.drawImage(imgElement, 0, 0, w, h);
            
            const imgData = tempCtx.getImageData(0, 0, w, h);
            const data = imgData.data;
            const length = w * h;
            const gray = new Uint8Array(length);
            
            // 1. グレースケール化
            for (let i = 0; i < length; i++) {
                const r = data[i * 4];
                const g = data[i * 4 + 1];
                const b = data[i * 4 + 2];
                gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
            }
            
            // 2. 大津の二値化 (Otsu's Thresholding) の閾値計算
            let hist = new Array(256).fill(0);
            for (let i = 0; i < length; i++) hist[gray[i]]++;
            
            let sum = 0;
            for (let i = 0; i < 256; i++) sum += i * hist[i];
            
            let sumB = 0, wB = 0, wF = 0, maxVar = 0, threshold = 0;
            for (let i = 0; i < 256; i++) {
                wB += hist[i];
                if (wB === 0) continue;
                wF = length - wB;
                if (wF === 0) break;
                
                sumB += i * hist[i];
                let mB = sumB / wB;
                let mF = (sum - sumB) / wF;
                let varBetween = wB * wF * (mB - mF) * (mB - mF);
                
                if (varBetween > maxVar) {
                    maxVar = varBetween;
                    threshold = i;
                }
            }
            
            logDebug(`Otsu threshold: ${threshold}`);

            // 画像中心のピクセルが明るいか暗いかで、名刺が白か黒かを判定
            let centerVal = gray[Math.floor(h / 2) * w + Math.floor(w / 2)];
            let isCardBright = centerVal > threshold;
            
            // 3. 4つの角（極値）を探す
            let minSum = Infinity, maxSum = -Infinity;
            let minDiff = Infinity, maxDiff = -Infinity;
            let tl = null, br = null, tr = null, bl = null;
            
            let fgCount = 0;

            for (let y = 1; y < h - 1; y++) {
                for (let x = 1; x < w - 1; x++) {
                    let val = gray[y * w + x];
                    let isForeground = isCardBright ? (val > threshold) : (val <= threshold);
                    
                    if (isForeground) {
                        // ノイズ除去 (Erosion相当): 周囲3x3ピクセルに十分な前景ピクセルがあるか
                        let count = 0;
                        for(let dy = -1; dy <= 1; dy++) {
                            for(let dx = -1; dx <= 1; dx++) {
                                let nval = gray[(y + dy) * w + (x + dx)];
                                if (isCardBright ? (nval > threshold) : (nval <= threshold)) count++;
                            }
                        }
                        if (count < 7) continue; // 孤立したノイズは無視

                        fgCount++;
                        let sumCoord = x + y;
                        let diffCoord = x - y;
                        
                        if (sumCoord < minSum) { minSum = sumCoord; tl = {x, y}; }
                        if (sumCoord > maxSum) { maxSum = sumCoord; br = {x, y}; }
                        if (diffCoord > maxDiff) { maxDiff = diffCoord; tr = {x, y}; }
                        if (diffCoord < minDiff) { minDiff = diffCoord; bl = {x, y}; }
                    }
                }
            }
            
            // 前景が極端に小さい、または大きすぎる場合はエラーとする
            if (fgCount < length * 0.05 || fgCount > length * 0.98) {
                logDebug(`Area out of bounds: ${Math.round(fgCount/length*100)}%`);
                return null;
            }
            
            if (tl && tr && br && bl) {
                logDebug("Pure JS detection success!");
                return [
                    {x: tl.x / scale, y: tl.y / scale},
                    {x: tr.x / scale, y: tr.y / scale},
                    {x: br.x / scale, y: br.y / scale},
                    {x: bl.x / scale, y: bl.y / scale}
                ];
            }
            
            logDebug("Could not find corners.");
            return null;
        } catch (err) {
            logDebug("PureJS err: " + err);
            console.error(err);
            return null;
        }
    }

    function loadImage(src, manualPoints = null) {
        sourceImage.onload = () => {
            initialView.classList.remove('active');
            resultView.classList.remove('active');
            editorView.classList.add('active');

            if (manualPoints) {
                // 回転時などは既存のポイントを維持する
                points = manualPoints;
                logDebug("Image rotated.");
                if (editorView.classList.contains('active')) {
                    drawEditor();
                }
            } else {
                // 4隅のポイントを初期化 (フォールバック用)
                const marginX = sourceImage.width * 0.1;
                const marginY = sourceImage.height * 0.1;
                points = [
                    {x: marginX, y: marginY}, // Top-Left
                    {x: sourceImage.width - marginX, y: marginY}, // Top-Right
                    {x: sourceImage.width - marginX, y: sourceImage.height - marginY}, // Bottom-Right
                    {x: marginX, y: sourceImage.height - marginY} // Bottom-Left
                ];

                logDebug("Image loaded.");
                
                // 初回読み込み時は自動認識を実行
                setTimeout(() => {
                    const detectedPoints = detectDocument(sourceImage);
                    if (detectedPoints) {
                        points = detectedPoints;
                        if (editorView.classList.contains('active')) {
                            drawEditor();
                        }
                    }
                }, 10);
            }

            // DOMの表示が完了してからキャンバスサイズを計算するため少し遅延させる
            setTimeout(resizeCanvas, 50);
        };
        sourceImage.src = src;
    }

    // キャンバスのリサイズと描画の更新
    function resizeCanvas() {
        const container = document.getElementById('editor-container');
        // 解像度を上げるための対応 (Retina等)
        const dpr = window.devicePixelRatio || 1;
        
        // CSS上のサイズ
        const rect = container.getBoundingClientRect();
        canvas.style.width = rect.width + 'px';
        canvas.style.height = rect.height + 'px';
        
        // 実際のピクセルサイズ
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;

        // スケール計算 (contain)
        const scaleX = canvas.width / sourceImage.width;
        const scaleY = canvas.height / sourceImage.height;
        displayScale = Math.min(scaleX, scaleY);

        offsetX = (canvas.width - sourceImage.width * displayScale) / 2;
        offsetY = (canvas.height - sourceImage.height * displayScale) / 2;

        drawEditor();
    }

    window.addEventListener('resize', () => {
        if (editorView.classList.contains('active')) {
            resizeCanvas();
        }
    });

    function drawEditor() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        
        // 画像を描画
        ctx.drawImage(
            sourceImage,
            offsetX, offsetY,
            sourceImage.width * displayScale,
            sourceImage.height * displayScale
        );

        // ガイドラインを描画
        ctx.beginPath();
        for (let i = 0; i < points.length; i++) {
            const p = imgToCanvas(points[i]);
            if (i === 0) ctx.moveTo(p.x, p.y);
            else ctx.lineTo(p.x, p.y);
        }
        ctx.closePath();
        ctx.lineWidth = 2 * (window.devicePixelRatio || 1);
        ctx.strokeStyle = '#007aff'; // Primary color
        ctx.stroke();
        ctx.fillStyle = 'rgba(0, 122, 255, 0.2)';
        ctx.fill();

        // 頂点を描画
        const dpr = window.devicePixelRatio || 1;
        const radius = 10 * dpr; // 見た目のサイズを元に戻す
        for (let i = 0; i < points.length; i++) {
            const p = imgToCanvas(points[i]);
            ctx.beginPath();
            ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
            ctx.fillStyle = (i === draggingPointIndex) ? '#ff3b30' : '#ffffff';
            ctx.fill();
            ctx.lineWidth = 3 * dpr;
            ctx.strokeStyle = '#007aff';
            ctx.stroke();
        }
    }

    // 座標変換ヘルパー
    function imgToCanvas(p) {
        return {
            x: p.x * displayScale + offsetX,
            y: p.y * displayScale + offsetY
        };
    }

    function canvasToImg(x, y) {
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        // マウス/タッチ座標(CSSピクセル)からCanvas内ピクセル座標へ
        const cx = (x - rect.left) * dpr;
        const cy = (y - rect.top) * dpr;
        
        return {
            x: Math.max(0, Math.min(sourceImage.width, (cx - offsetX) / displayScale)),
            y: Math.max(0, Math.min(sourceImage.height, (cy - offsetY) / displayScale))
        };
    }

    // イベントハンドリング
    function getPointerPos(e) {
        if (e.touches && e.touches.length > 0) {
            return { x: e.touches[0].clientX, y: e.touches[0].clientY };
        }
        return { x: e.clientX, y: e.clientY };
    }

    function handleStart(e) {
        e.preventDefault();
        const pos = getPointerPos(e);
        const imgPos = canvasToImg(pos.x, pos.y);
        
        // 当たり判定をさらに特大に拡大（CSSピクセルで80px相当 -> 直径160px）
        const dpr = window.devicePixelRatio || 1;
        const threshold = (80 * dpr) / displayScale; 
        let minDist = Infinity;
        let closestIndex = -1;
        
        for (let i = 0; i < points.length; i++) {
            const dx = points[i].x - imgPos.x;
            const dy = points[i].y - imgPos.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < minDist && dist < threshold) {
                minDist = dist;
                closestIndex = i;
            }
        }
        
        if (closestIndex !== -1) {
            draggingPointIndex = closestIndex;
            // 触れた瞬間にポイントを指の位置に吸着させる (操作感が劇的に改善)
            points[draggingPointIndex] = imgPos;
            drawEditor();
        }
    }

    function handleMove(e) {
        if (draggingPointIndex === -1) return;
        e.preventDefault();
        const pos = getPointerPos(e);
        const imgPos = canvasToImg(pos.x, pos.y);
        points[draggingPointIndex] = imgPos;
        drawEditor();
    }

    function handleEnd(e) {
        if (draggingPointIndex !== -1) {
            draggingPointIndex = -1;
            drawEditor();
        }
    }

    canvas.addEventListener('mousedown', handleStart);
    canvas.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleEnd);

    canvas.addEventListener('touchstart', handleStart, {passive: false});
    canvas.addEventListener('touchmove', handleMove, {passive: false});
    window.addEventListener('touchend', handleEnd);

    // 回転
    function rotateImage(angleDegrees) {
        const src = fullResBitmap || sourceImage;
        const offCanvas = document.createElement('canvas');
        const offCtx = offCanvas.getContext('2d');
        const w = src.width;
        const h = src.height;
        let newPoints = null;

        if (angleDegrees === 90 || angleDegrees === -270) {
            offCanvas.width = h;
            offCanvas.height = w;
            offCtx.translate(offCanvas.width, 0);
            offCtx.rotate(Math.PI / 2);
            // Rotate points +90 deg for UI coordinates (note: points are relative to sourceImage display size, but we use src width/height here which is the same ratio)
            newPoints = points.map(p => ({ x: h - p.y, y: p.x }));
        } else if (angleDegrees === -90 || angleDegrees === 270) {
            offCanvas.width = h;
            offCanvas.height = w;
            offCtx.translate(0, offCanvas.height);
            offCtx.rotate(-Math.PI / 2);
            newPoints = points.map(p => ({ x: p.y, y: w - p.x }));
        }
        
        if (newPoints) {
            newPoints = sortPoints(newPoints);
        }

        offCtx.drawImage(src, 0, 0);
        
        offCanvas.toBlob(async (blob) => {
            if (blob) {
                try {
                    if (window.createImageBitmap) {
                        const newBmp = await createImageBitmap(blob);
                        if (fullResBitmap) fullResBitmap.close && fullResBitmap.close();
                        fullResBitmap = newBmp;
                    }
                } catch(e) {}
                const objectUrl = URL.createObjectURL(blob);
                loadImage(objectUrl, newPoints);
            }
        }, 'image/jpeg', 0.98);
    }

    rotateLeftBtn.addEventListener('click', () => rotateImage(-90));
    rotateRightBtn.addEventListener('click', () => rotateImage(90));

    // リセット関数
    const resetToInitial = () => {
        editorView.classList.remove('active');
        resultView.classList.remove('active');
        initialView.classList.add('active');
        
        imageInput.value = '';
        sourceImage.src = '';
        croppedResultImg.src = '';
        currentDataUrl = null;
    };

    cancelBtn.addEventListener('click', resetToInitial);
    startOverBtn.addEventListener('click', resetToInitial);

    backToEditBtn.addEventListener('click', () => {
        resultView.classList.remove('active');
        editorView.classList.add('active');
        // リサイズ再計算が必要な場合があるため
        setTimeout(resizeCanvas, 50);
    });

    // ==== 射影変換（Perspective Transform）の数学処理 ====
    function solveLinearSystem(A, B) {
        const n = A.length;
        for (let i = 0; i < n; i++) {
            let maxEl = Math.abs(A[i][i]), maxRow = i;
            for (let k = i + 1; k < n; k++) {
                if (Math.abs(A[k][i]) > maxEl) {
                    maxEl = Math.abs(A[k][i]);
                    maxRow = k;
                }
            }
            let tmp = A[maxRow]; A[maxRow] = A[i]; A[i] = tmp;
            let tmpB = B[maxRow]; B[maxRow] = B[i]; B[i] = tmpB;
            for (let k = i + 1; k < n; k++) {
                let c = -A[k][i] / A[i][i];
                for (let j = i; j < n; j++) {
                    if (i === j) A[k][j] = 0;
                    else A[k][j] += c * A[i][j];
                }
                B[k] += c * B[i];
            }
        }
        let x = new Array(n).fill(0);
        for (let i = n - 1; i >= 0; i--) {
            x[i] = B[i] / A[i][i];
            for (let k = i - 1; k >= 0; k--) {
                B[k] -= A[k][i] * x[i];
            }
        }
        return x;
    }

    function getPerspectiveTransform(srcPts, dstPts) {
        let A = [], B = [];
        for (let i = 0; i < 4; i++) {
            let u = dstPts[i].x, v = dstPts[i].y;
            let x = srcPts[i].x, y = srcPts[i].y;
            A.push([u, v, 1, 0, 0, 0, -x * u, -x * v]);
            B.push(x);
            A.push([0, 0, 0, u, v, 1, -y * u, -y * v]);
            B.push(y);
        }
        return solveLinearSystem(A, B);
    }

    function warpPerspective(srcCanvas, dstWidth, dstHeight, h) {
        const dstCanvas = document.createElement('canvas');
        dstCanvas.width = dstWidth;
        dstCanvas.height = dstHeight;
        const dstCtx = dstCanvas.getContext('2d');
        
        const srcCtx = srcCanvas.getContext('2d');
        const srcImgData = srcCtx.getImageData(0, 0, srcCanvas.width, srcCanvas.height);
        const dstImgData = dstCtx.createImageData(dstWidth, dstHeight);
        
        const srcData = srcImgData.data;
        const dstData = dstImgData.data;
        const sw = srcCanvas.width;
        const sh = srcCanvas.height;

        for (let y = 0; y < dstHeight; y++) {
            for (let x = 0; x < dstWidth; x++) {
                const denominator = h[6] * x + h[7] * y + 1;
                const srcX = (h[0] * x + h[1] * y + h[2]) / denominator;
                const srcY = (h[3] * x + h[4] * y + h[5]) / denominator;
                
                const srcX_f = Math.floor(srcX);
                const srcY_f = Math.floor(srcY);
                
                if (srcX_f >= 0 && srcX_f < sw - 1 && srcY_f >= 0 && srcY_f < sh - 1) {
                    const dx = srcX - srcX_f;
                    const dy = srcY - srcY_f;
                    
                    const idx1 = (srcY_f * sw + srcX_f) * 4;
                    const idx2 = idx1 + 4;
                    const idx3 = ((srcY_f + 1) * sw + srcX_f) * 4;
                    const idx4 = idx3 + 4;
                    
                    const dstIdx = (y * dstWidth + x) * 4;
                    
                    for (let c = 0; c < 3; c++) {
                        const val = srcData[idx1 + c] * (1 - dx) * (1 - dy) +
                                    srcData[idx2 + c] * dx * (1 - dy) +
                                    srcData[idx3 + c] * (1 - dx) * dy +
                                    srcData[idx4 + c] * dx * dy;
                        dstData[dstIdx + c] = val;
                    }
                    dstData[dstIdx + 3] = 255;
                }
            }
        }
        dstCtx.putImageData(dstImgData, 0, 0);
        return dstCanvas;
    }

    // 保存ボタン (Perspective Correction実行)
    saveBtn.addEventListener('click', () => {
        // 出力サイズは名刺の比率 (91:55) に合わせる。
        // ポイントの幅を基準に出力解像度を決定（最大長辺を4500pxに制限して1200万画素をカバー）
        const widthT = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
        const widthB = Math.hypot(points[2].x - points[3].x, points[2].y - points[3].y);
        const estWidth = Math.max(widthT, widthB);
        
        // 解像度を元のピクセルからさらに1.5倍にオーバーサンプリングしてジャギーを防ぐ
        let dstW = Math.min(Math.round(estWidth * 1.5), 4500);
        let dstH = Math.round(dstW * (55 / 91));
        
        const heightL = Math.hypot(points[3].x - points[0].x, points[3].y - points[0].y);
        const heightR = Math.hypot(points[2].x - points[1].x, points[2].y - points[1].y);
        const estHeight = Math.max(heightL, heightR);
        if (estHeight > estWidth) {
            dstH = Math.min(Math.round(estHeight * 1.5), 4500);
            dstW = Math.round(dstH * (55 / 91));
        }

        const dstPts = [
            {x: 0, y: 0},
            {x: dstW, y: 0},
            {x: dstW, y: dstH},
            {x: 0, y: dstH}
        ];
        
        const H = getPerspectiveTransform(points, dstPts);

        const src = fullResBitmap || sourceImage;
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = src.width;
        tempCanvas.height = src.height;
        tempCanvas.getContext('2d').drawImage(src, 0, 0);

        setTimeout(() => {
            const warpedCanvas = warpPerspective(tempCanvas, dstW, dstH, H);
            
            // クッキリとした書類にするためのシャープネス処理（アンシャープマスク）
            const ctx = warpedCanvas.getContext('2d');
            const imgData = ctx.getImageData(0, 0, dstW, dstH);
            const data = imgData.data;
            const w = dstW;
            const h = dstH;
            
            // 簡単な 3x3 シャープネスフィルタ
            const sharpData = new Uint8ClampedArray(data);
            for (let y = 1; y < h - 1; y++) {
                for (let x = 1; x < w - 1; x++) {
                    const idx = (y * w + x) * 4;
                    for (let c = 0; c < 3; c++) {
                        const top = ((y - 1) * w + x) * 4 + c;
                        const left = (y * w + (x - 1)) * 4 + c;
                        const right = (y * w + (x + 1)) * 4 + c;
                        const bottom = ((y + 1) * w + x) * 4 + c;
                        
                        const val = data[idx+c] * 5 - data[top] - data[left] - data[right] - data[bottom];
                        sharpData[idx+c] = val;
                    }
                }
            }
            ctx.putImageData(new ImageData(sharpData, w, h), 0, 0);

            warpedCanvas.toBlob((blob) => {
                if (blob) {
                    if (currentDataUrl) URL.revokeObjectURL(currentDataUrl);
                    currentDataUrl = URL.createObjectURL(blob);
                    
                    croppedResultImg.src = currentDataUrl;
                    editorView.classList.remove('active');
                    resultView.classList.add('active');
                }
            }, 'image/jpeg', 0.98);
        }, 10);
    });

    downloadBtn.addEventListener('click', () => {
        if (!currentDataUrl) return;
        const a = document.createElement('a');
        a.href = currentDataUrl;
        
        const nameParts = originalFileName.split('.');
        const ext = nameParts.length > 1 ? nameParts.pop() : 'jpg';
        const baseName = nameParts.join('.');
        a.download = `${baseName}_corrected.jpg`;
        
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    });
});
