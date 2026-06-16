<?php
/**
 * DATUM Ad Slot sidebar widget.
 *
 * @package DatumPublisher
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Class Datum_Widget
 *
 * Extends WP_Widget to provide a draggable ad slot in Appearance → Widgets.
 */
class Datum_Widget extends WP_Widget {

	/** Valid IAB slot format values */
	const VALID_FORMATS = array(
		'medium-rectangle' => 'Medium Rectangle (300×250)',
		'leaderboard'      => 'Leaderboard (728×90)',
		'wide-skyscraper'  => 'Wide Skyscraper (160×600)',
		'half-page'        => 'Half Page (300×600)',
		'mobile-banner'    => 'Mobile Banner (320×50)',
		'square'           => 'Square (250×250)',
		'large-rectangle'  => 'Large Rectangle (336×280)',
	);

	/** Per-slot display-mode override (empty label = inherit the global default). */
	const VALID_MODES = array(
		''        => 'Use site default',
		'full'    => 'Full — house-ad banner',
		'minimal' => 'Minimal — slim placeholder',
		'silent'  => 'Silent — collapse',
	);

	public function __construct() {
		parent::__construct(
			'datum_ad_slot',
			__( 'DATUM Ad Slot', 'datum-publisher' ),
			array(
				'description'           => __( 'Display a DATUM ad slot in a widget area. Earn DOT for verified impressions.', 'datum-publisher' ),
				'customize_selective_refresh' => true,
			)
		);
	}

	/**
	 * Front-end display.
	 *
	 * @param array $args     Widget area arguments (before_widget, after_widget, etc.).
	 * @param array $instance Widget instance settings.
	 */
	public function widget( $args, $instance ) {
		$settings = datum_publisher_get_settings();
		if ( empty( $settings['publisher'] ) ) {
			return;
		}

		$format = ! empty( $instance['format'] ) ? $instance['format'] : 'medium-rectangle';
		if ( ! array_key_exists( $format, self::VALID_FORMATS ) ) {
			$format = 'medium-rectangle';
		}

		$title = ! empty( $instance['title'] ) ? $instance['title'] : '';
		$title = apply_filters( 'widget_title', $title, $instance, $this->id_base );

		echo wp_kses_post( $args['before_widget'] );

		if ( $title ) {
			echo wp_kses_post( $args['before_title'] . $title . $args['after_title'] );
		}

		$mode      = ! empty( $instance['mode'] ) ? $instance['mode'] : '';
		$mode_attr = array_key_exists( $mode, self::VALID_MODES ) && '' !== $mode
			? ' data-datum-mode="' . esc_attr( $mode ) . '"'
			: '';

		printf(
			'<div class="datum-ad-slot" data-datum-slot="%s"%s></div>',
			esc_attr( $format ),
			$mode_attr
		);

		echo wp_kses_post( $args['after_widget'] );
	}

	/**
	 * Back-end widget form in Appearance → Widgets.
	 *
	 * @param array $instance Widget instance settings.
	 */
	public function form( $instance ) {
		$title  = ! empty( $instance['title'] ) ? $instance['title'] : '';
		$format = ! empty( $instance['format'] ) ? $instance['format'] : 'medium-rectangle';
		$mode   = ! empty( $instance['mode'] ) ? $instance['mode'] : '';
		?>
		<p>
			<label for="<?php echo esc_attr( $this->get_field_id( 'title' ) ); ?>">
				<?php esc_html_e( 'Title (optional):', 'datum-publisher' ); ?>
			</label>
			<input
				class="widefat"
				id="<?php echo esc_attr( $this->get_field_id( 'title' ) ); ?>"
				name="<?php echo esc_attr( $this->get_field_name( 'title' ) ); ?>"
				type="text"
				value="<?php echo esc_attr( $title ); ?>"
			/>
		</p>
		<p>
			<label for="<?php echo esc_attr( $this->get_field_id( 'format' ) ); ?>">
				<?php esc_html_e( 'Ad Format:', 'datum-publisher' ); ?>
			</label>
			<select
				class="widefat"
				id="<?php echo esc_attr( $this->get_field_id( 'format' ) ); ?>"
				name="<?php echo esc_attr( $this->get_field_name( 'format' ) ); ?>"
			>
				<?php foreach ( self::VALID_FORMATS as $value => $label ) : ?>
					<option value="<?php echo esc_attr( $value ); ?>" <?php selected( $format, $value ); ?>>
						<?php echo esc_html( $label ); ?>
					</option>
				<?php endforeach; ?>
			</select>
		</p>
		<p>
			<label for="<?php echo esc_attr( $this->get_field_id( 'mode' ) ); ?>">
				<?php esc_html_e( 'Display Mode:', 'datum-publisher' ); ?>
			</label>
			<select
				class="widefat"
				id="<?php echo esc_attr( $this->get_field_id( 'mode' ) ); ?>"
				name="<?php echo esc_attr( $this->get_field_name( 'mode' ) ); ?>"
			>
				<?php foreach ( self::VALID_MODES as $value => $label ) : ?>
					<option value="<?php echo esc_attr( $value ); ?>" <?php selected( $mode, $value ); ?>>
						<?php echo esc_html( $label ); ?>
					</option>
				<?php endforeach; ?>
			</select>
		</p>
		<?php
	}

	/**
	 * Sanitize widget instance on save.
	 *
	 * @param array $new_instance New settings.
	 * @param array $old_instance Previous settings.
	 * @return array
	 */
	public function update( $new_instance, $old_instance ) {
		$instance = array();

		$instance['title'] = sanitize_text_field( $new_instance['title'] ?? '' );

		$format = sanitize_text_field( $new_instance['format'] ?? 'medium-rectangle' );
		$instance['format'] = array_key_exists( $format, self::VALID_FORMATS )
			? $format
			: 'medium-rectangle';

		$mode = sanitize_text_field( $new_instance['mode'] ?? '' );
		$instance['mode'] = array_key_exists( $mode, self::VALID_MODES ) ? $mode : '';

		return $instance;
	}
}

/**
 * Register the widget.
 */
function datum_publisher_register_widget() {
	register_widget( 'Datum_Widget' );
}
add_action( 'widgets_init', 'datum_publisher_register_widget' );
