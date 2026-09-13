/** Shared by the route fallback and map, so loading stays visible across lazy boundaries. */
export default function LoadingVeil({ visible = true }: { visible?: boolean }) {
  return (
    <div className={`map-veil${visible ? "" : " is-gone"}`} role="status" aria-hidden={!visible}>
      <div className="map-veil__core">
        {/*
          团队 logo 只放一件：整条字标（含前面的符号）。
          原来这里还并排了一个单独的符号，和字标里自带的那个重复 ——
          和顶栏、登录页的口径统一为「一份 logo，居中」。
          居中由 `.map-veil__core`（grid + justify-items:center）保证，
          转圈退到 logo 下面当进度指示。素材与 index.html 的首屏加载态一致，
          避免「HTML 首屏 → React 加载页」这一跳换牌子。
        */}
        <img className="map-veil__wordmark" src="/brand/mumai-wordmark-white.png" alt="木脉智检" />
        <span className="map-veil__rings" aria-hidden="true">
          <i className="map-veil__ring map-veil__ring--outer" />
          <i className="map-veil__ring map-veil__ring--mid" />
          <i className="map-veil__ring map-veil__ring--inner" />
        </span>
        <span className="map-veil__ascii">MAP INITIALIZING</span>
        <i className="map-veil__line" />
      </div>
    </div>
  );
}
