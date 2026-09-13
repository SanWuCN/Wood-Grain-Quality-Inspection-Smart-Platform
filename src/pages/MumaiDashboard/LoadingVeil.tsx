/** Shared by the route fallback and map, so loading stays visible across lazy boundaries. */
export default function LoadingVeil({ visible = true }: { visible?: boolean }) {
  return (
    <div className={`map-veil${visible ? "" : " is-gone"}`} role="status" aria-hidden={!visible}>
      <div className="map-veil__core">
        <span className="map-veil__rings" aria-hidden="true">
          <i className="map-veil__ring map-veil__ring--outer" />
          <i className="map-veil__ring map-veil__ring--mid" />
          <i className="map-veil__ring map-veil__ring--inner" />
        </span>
        <b>木脉智检</b>
        <span className="map-veil__ascii">MAP INITIALIZING</span>
        <i className="map-veil__line" />
      </div>
    </div>
  );
}
