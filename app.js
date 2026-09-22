document.addEventListener('DOMContentLoaded', () => {
    const initialView = document.getElementById('initial-view');
    const editorView = document.getElementById('editor-view');
    const imageInput = document.getElementById('image-input');
    const imageElement = document.getElementById('image-to-crop');
    const saveBtn = document.getElementById('save-btn');
    const cancelBtn = document.getElementById('cancel-btn');
    const rotateLeftBtn = document.getElementById('rotate-left');
    const rotateRightBtn = document.getElementById('rotate-right');
    
    let cropper = null;
    let originalFileName = 'business_card.jpg';

    // ファイルが選択されたときの処理
    imageInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        // 元のファイル名を保持（拡張子を変えたい場合はここで処理）
        originalFileName = file.name || 'business_card.jpg';

        const reader = new FileReader();
        reader.onload = (event) => {
            // 画像のソースを設定
            imageElement.src = event.target.result;
            
            // ビューの切り替え
            initialView.classList.remove('active');
            editorView.classList.add('active');

            // 既存のCropperがあれば破棄
            if (cropper) {
                cropper.destroy();
            }

            // 画像の読み込みが完了してからCropperを初期化
            imageElement.onload = () => {
                cropper = new Cropper(imageElement, {
                    // 名刺の比率に近い設定にしたい場合はここをコメントアウト外す
                    // aspectRatio: 91 / 55, 
                    viewMode: 1, // トリミング枠が画像をはみ出さないようにする
                    dragMode: 'move', // キャンバスをドラッグで移動
                    autoCropArea: 0.9, // 初期トリミング枠の大きさ
                    restore: false,
                    guides: true,
                    center: true,
                    highlight: false,
                    cropBoxMovable: true,
                    cropBoxResizable: true,
                    toggleDragModeOnDblclick: false,
                });
            };
        };
        reader.readAsDataURL(file);
    });

    // 回転ボタン
    rotateLeftBtn.addEventListener('click', () => {
        if (cropper) cropper.rotate(-90);
    });

    rotateRightBtn.addEventListener('click', () => {
        if (cropper) cropper.rotate(90);
    });

    // キャンセルボタン
    cancelBtn.addEventListener('click', () => {
        // ビューを元に戻す
        editorView.classList.remove('active');
        initialView.classList.add('active');
        
        // 入力のリセット
        imageInput.value = '';
        
        if (cropper) {
            cropper.destroy();
            cropper = null;
        }
        imageElement.src = '';
    });

    // 保存ボタン
    saveBtn.addEventListener('click', () => {
        if (!cropper) return;

        // トリミングされた領域のCanvasを取得
        const canvas = cropper.getCroppedCanvas({
            // 出力解像度の制限（必要に応じて調整）
            maxWidth: 4096,
            maxHeight: 4096,
        });

        if (!canvas) {
            alert('画像の処理に失敗しました。');
            return;
        }

        // 画質を指定してデータURLに変換
        const dataUrl = canvas.toDataURL('image/jpeg', 0.9);

        // ダウンロード用のリンクを作成してクリックする
        const a = document.createElement('a');
        a.href = dataUrl;
        
        // ファイル名を生成（元のファイル名 + _cropped.jpg）
        const nameParts = originalFileName.split('.');
        const ext = nameParts.length > 1 ? nameParts.pop() : 'jpg';
        const baseName = nameParts.join('.');
        a.download = `${baseName}_cropped.jpg`;
        
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    });
});
